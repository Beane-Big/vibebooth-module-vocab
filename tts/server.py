# 背单词的朗读服务，用 onnxruntime / sherpa-onnx 在 CPU 上合成语音：
#   - 英文：Kokoro-82M v1.0（Apache 2.0）。文字先用 misaki（Kokoro 官方的英文注音，Apache 2.0）转成音素：它有自己的美音、英音词典，
#     按 spaCy 标出的词性挑同形词的读音；词典里没有的词（多是人名）交给 espeak-ng。
#     普通单词保持 Kokoro 原生直出与默认裁剪（避免强加句点或句级风格向量带来多余尾音）；
#     仅定向修复美音 af_heart 词尾 ʤ/ʧ 吞音（如 large 的 /dʒ/）以及孤立功能词（如 they、a、an、than）的弱读/失真。
#   - 中文（含中英混读）：Kokoro-82M-v1.1-zh（Apache 2.0，由 sherpa-onnx 推理），原生支持同一说话人自然读出中英混排，
#     彻底消除男声/女声混读，并通过自定义词典精准修正高频多音字（目的地、能干等）。
# 只在模块内部网络里给后端调用，不对外，也不做缓存：后端把合成好的音频存在卷里，同一句只合成一次。
import io
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx
import soundfile as sf
from kokoro_onnx import Kokoro
from misaki import en, espeak

from voices import VOICES, ZH_VOICES

MODEL_DIR = os.environ.get("MODEL_DIR", "/models")
ZH_DIR = f"{MODEL_DIR}/kokoro-zh"
MAX_TEXT = 500

kokoro = Kokoro(f"{MODEL_DIR}/model.onnx", f"{MODEL_DIR}/voices.npz")
g2p = {b: en.G2P(british=b, fallback=espeak.EspeakFallback(british=b), unk="") for b in (False, True)}

zh_tts_config = sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(
        kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=f"{ZH_DIR}/model.int8.onnx",
            voices=f"{ZH_DIR}/voices.bin",
            tokens=f"{ZH_DIR}/tokens.txt",
            lexicon=f"{ZH_DIR}/lexicon-us-en.txt,{ZH_DIR}/lexicon-zh.txt,{ZH_DIR}/lexicon-custom.txt",
        ),
        provider="cpu",
        num_threads=min(4, os.cpu_count() or 2),
        debug=False,
    ),
    rule_fsts=f"{ZH_DIR}/phone-zh.fst,{ZH_DIR}/date-zh.fst,{ZH_DIR}/number-zh.fst",
    max_num_sentences=1,
    silence_scale=0.2,
)
if not zh_tts_config.validate():
    raise RuntimeError("Invalid sherpa-onnx Kokoro Chinese TTS config")
zh_tts = sherpa_onnx.OfflineTts(zh_tts_config)

# 读取中文模型词表和词典键，供中英混读遇到未登录英文词时走 misaki 音素兜底（保持同一中文女声音色）。
zh_valid_tokens: set[str] = set()
with open(f"{ZH_DIR}/tokens.txt", encoding="utf-8") as _f:
    for _line in _f:
        _parts = _line.strip().split()
        if len(_parts) == 2:
            zh_valid_tokens.add(_parts[0])
zh_valid_tokens.add(" ")

zh_lexicon: dict[str, list[str]] = {}
zh_max_phrase_len = 1
for _lex_name in ("lexicon-us-en.txt", "lexicon-zh.txt", "lexicon-custom.txt"):
    with open(f"{ZH_DIR}/{_lex_name}", encoding="utf-8") as _f:
        for _line in _f:
            _s = _line.strip()
            if " " in _s:
                _k, _v = _s.split(" ", 1)
                _kl = _k.lower()
                zh_lexicon[_kl] = _v.split()
                if len(_kl) > zh_max_phrase_len and re.search(r"[\u3400-\u9fff]", _kl):
                    zh_max_phrase_len = len(_kl)

# onnxruntime 一次合成就会用满所有核，同时合成几句并不更快，所以一次只合成一句。
lock = threading.Lock()

# 孤立英文单词（拼读 / 查词 / 单词页）时，misaki 会把部分功能词按句内弱读输出（如 a→ɐ、an→ɐn、than→ðən、they→ðA），
# 这里强制转为词典标准强读音素，避免单读发虚或读偏。
STANDALONE_WORD_RE = re.compile(r"^[A-Za-z0-9'’-]+$")
ENGLISH_VOWELS = frozenset("AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ")
STANDALONE_OVERRIDES = {
    False: {"a": "ˈA", "an": "ˈæn", "am": "ˈæm", "the": "ðˈə", "than": "ðˈæn"},
    True: {"a": "ˈA", "an": "ˈan", "am": "ˈam", "the": "ðˈə", "than": "ðˈan"},
}
# 仅对极少数在极短风格向量上明显读偏的孤立词（目前实测仅 they）复用中短句风格行，绝不波及普通单词。
SHORT_STYLE_WORDS = frozenset({"they"})
LATIN_TOKEN_RE = re.compile(r"[A-Za-z]+(?:['’-][A-Za-z]+)*")
CJK_PUNCT_MAP = {"，": ",", "、": ",", "。": ".", "！": "!", "？": "?", "；": ";", "：": ",", "…": "…"}
DIGIT_ZH_MAP = {"0": "零", "1": "一", "2": "二", "3": "三", "4": "四", "5": "五", "6": "六", "7": "七", "8": "八", "9": "九"}


def safe_trim(samples: np.ndarray, rate: int, head_ms: int = 40, tail_ms: int = 80, db_floor: float = 48.0) -> np.ndarray:
    """温和裁剪中文音频首尾纯静音，保留充足头尾缓冲。"""
    if len(samples) == 0:
        return samples
    audio = np.asarray(samples, dtype=np.float32)
    frame = max(1, rate // 100)  # 10 ms 窗口，远细于 librosa 默认的 85 ms
    n_frames = len(audio) // frame
    if n_frames == 0:
        return audio
    rms = np.sqrt(np.mean(audio[: n_frames * frame].reshape(n_frames, frame) ** 2, axis=1))
    peak = float(np.max(rms))
    if peak <= 1e-6:
        return audio
    threshold = max(1e-4, peak * (10.0 ** (-db_floor / 20.0)))
    active = np.flatnonzero(rms > threshold)
    if len(active) == 0:
        return audio
    head_pad = round(rate * head_ms / 1000)
    tail_pad = round(rate * tail_ms / 1000)
    start = max(0, int(active[0]) * frame - head_pad)
    end = min(len(audio), int(active[-1] + 1) * frame + tail_pad)
    return audio[start:end]


def english_phonemes(text: str, british: bool) -> tuple[str, bool]:
    single_word = bool(STANDALONE_WORD_RE.fullmatch(text))
    low = text.lower()
    overrides = STANDALONE_OVERRIDES[british]
    if single_word and low in overrides:
        phonemes = overrides[low]
    else:
        phonemes, _ = g2p[british](text)
        if not phonemes:
            raise ValueError(f"English G2P produced no phonemes for {text!r}")
        if single_word and "ˈ" not in phonemes and any(c in ENGLISH_VOWELS for c in phonemes):
            # 孤立功能词（they、he、we、you、to、for、of、go、with 等）在词典中无主重音，
            # 补上主重音使单读清晰饱满，和词典音标一致。
            phonemes = en.apply_stress(phonemes, 2)
    # Kokoro 上游已知缺陷（hexgrad/kokoro #284）：
    # af_heart 在孤立单词结尾遇到紧缩塞擦音 ʤ（如 large/age/bridge/change）或 ʧ（如 catch/match）时尾音能量几乎归零；
    # 拆成标准两字符 dʒ / tʃ 可恢复完整尾音（bf_emma 原本正常且拆分会反向劣化，故仅针对美音 af_heart）。
    if single_word and not british:
        if phonemes.endswith("ʤ"):
            phonemes = phonemes[:-1] + "dʒ"
        elif phonemes.endswith("ʧ"):
            phonemes = phonemes[:-1] + "tʃ"
    # 不给孤立单词额外追加句点 "."，避免 Kokoro 在单词末尾合成句末呼气尾音。
    return phonemes, single_word


def _style_row(voice: str, row: int):
    style_table = kokoro.get_voice_style(voice)
    idx = min(row, len(style_table) - 1)
    return np.repeat(style_table[idx : idx + 1], len(style_table), axis=0)


def english_audio(text: str, voice: str):
    british = VOICES[voice]
    phonemes, single_word = english_phonemes(text, british)
    # 普通英文单词与整句全部保持原生 voice + trim=True（与 0.7.7 一致），杜绝风格向量跨长度错配带来的 s 类尾音；
    # 仅对 SHORT_STYLE_WORDS（如 they）定向使用稳定风格行。
    voice_arg = _style_row(voice, 16) if (single_word and text.lower() in SHORT_STYLE_WORDS) else voice
    samples, rate = kokoro.create(phonemes, voice=voice_arg, is_phonemes=True, trim=True)
    if len(samples) == 0:
        raise ValueError("English speech produced no audio")
    return samples, rate


def _has_oov_latin(text: str) -> bool:
    for m in LATIN_TOKEN_RE.finditer(text):
        word = m.group(0).lower()
        if word in zh_lexicon:
            continue
        if "-" in word and all(part in zh_lexicon for part in word.split("-") if part):
            continue
        return True
    return False


def _mixed_tokens_for_zh(text: str) -> list[str]:
    """当中文里包含词典未收录的英文新词时，中文走 lexicon-zh，英文走 misaki，合为同一套 Kokoro 音素由同一个中文女声合成。"""
    tokens: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch.isspace():
            if tokens and tokens[-1] != " ":
                tokens.append(" ")
            i += 1
            continue
        if ch in CJK_PUNCT_MAP:
            tokens.append(CJK_PUNCT_MAP[ch])
            i += 1
            continue
        if ch in ",.;:!?":
            tokens.append(ch)
            i += 1
            continue
        m = LATIN_TOKEN_RE.match(text, i)
        if m:
            span = m.group(0)
            i = m.end()
            low = span.lower()
            if low in zh_lexicon:
                tokens.extend(t for t in zh_lexicon[low] if t in zh_valid_tokens)
            else:
                ph, _ = g2p[False](span)
                tokens.extend(c for c in ph if c in zh_valid_tokens and c != " ")
            tokens.append(" ")
            continue
        if ch in DIGIT_ZH_MAP:
            zh_digit = DIGIT_ZH_MAP[ch]
            if zh_digit in zh_lexicon:
                tokens.extend(t for t in zh_lexicon[zh_digit] if t in zh_valid_tokens)
            i += 1
            continue
        # 中文词组最长匹配
        matched = False
        for length in range(min(zh_max_phrase_len, n - i), 0, -1):
            piece = text[i : i + length]
            if piece in zh_lexicon:
                tokens.extend(t for t in zh_lexicon[piece] if t in zh_valid_tokens)
                i += length
                matched = True
                break
        if not matched:
            i += 1
    while tokens and tokens[-1] == " ":
        tokens.pop()
    if tokens and tokens[-1] not in ",.;:!?…":
        tokens.append(".")
    return tokens


def chinese_audio(text: str, voice: str):
    gen_config = sherpa_onnx.GenerationConfig()
    gen_config.sid = ZH_VOICES[voice]
    gen_config.speed = 1.0
    gen_config.silence_scale = 0.2
    if _has_oov_latin(text):
        toks = _mixed_tokens_for_zh(text)
        if not toks:
            raise ValueError("Chinese mixed speech produced no tokens")
        gen_config.tokens = [toks]
        audio = zh_tts.generate("", gen_config)
    else:
        audio = zh_tts.generate(text, gen_config)
    if len(audio.samples) == 0:
        raise ValueError("Chinese speech produced no audio")
    samples = safe_trim(np.asarray(audio.samples, dtype=np.float32), audio.sample_rate)
    if len(samples) == 0:
        raise ValueError("Chinese speech produced no audio")
    return samples, audio.sample_rate


def synthesize(text: str, voice: str) -> bytes:
    t0 = time.monotonic()
    with lock:
        t1 = time.monotonic()
        if voice in ZH_VOICES:
            audio, rate = chinese_audio(text, voice)
        else:
            audio, rate = english_audio(text, voice)
    buf = io.BytesIO()
    sf.write(buf, audio, rate, format="MP3")
    dt = time.monotonic() - t1
    wait_dt = t1 - t0
    if dt >= 0.8 or wait_dt >= 0.5:
        print(f"TTS {voice} ({len(text)} chars): synth={dt:.2f}s wait={wait_dt:.2f}s", flush=True)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.reply(200, b'{"status":"ok"}', "application/json")
        else:
            self.reply(404, b"not found")

    # POST /speak {"text": "...", "voice": "af_heart"} → MP3（voice 是 VOICES 或 ZH_VOICES 里的名字）
    def do_POST(self):
        if self.path != "/speak":
            return self.reply(404, b"not found")
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            text, voice = str(body["text"]).strip(), body["voice"]
        except (ValueError, KeyError, TypeError):
            return self.reply(400, b"bad request")
        if (voice not in VOICES and voice not in ZH_VOICES) or not text or len(text) > MAX_TEXT:
            return self.reply(400, b"bad voice or text")
        try:
            self.reply(200, synthesize(text, voice), "audio/mpeg")
        except Exception as e:  # 合成失败只影响这一句，后端会退回浏览器朗读
            self.log_error("合成失败 %r: %s", text, e)
            self.reply(500, b"synthesis failed")

    def reply(self, code: int, data: bytes, ctype: str = "text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    # 先各合成一句，把模型和词典都加载好，第一次朗读不用等。
    synthesize("Ready.", "af_heart")
    synthesize("large", "af_heart")
    synthesize("they", "af_heart")
    for v in ZH_VOICES:
        synthesize("准备好了。", v)
    print("vocab-tts 已启动，端口 8880", flush=True)
    ThreadingHTTPServer(("", 8880), Handler).serve_forever()
