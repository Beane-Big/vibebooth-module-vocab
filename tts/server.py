# 背单词的朗读服务，用 onnxruntime 在 CPU 上合成语音：
#   - 英文：Kokoro-82M（Apache 2.0）。文字先用 misaki（Kokoro 官方的英文注音，Apache 2.0）转成音素：它有自己的美音、英音词典，
#     按 spaCy 标出的词性挑同形词的读音；词典里没有的词（多是人名）交给 espeak-ng。
#   - 中文：Piper（GPL-3.0）的超文声音。Piper 用 g2pW 按上下文判断多音字（银行的“行”、重新的“重”），再转成拼音合成。
# 只在模块内部网络里给后端调用，不对外，也不做缓存：后端把合成好的音频存在卷里，同一句只合成一次。
import io
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro
from misaki import en, espeak
from piper import PiperVoice

from voices import PIPER_VOICES, VOICES

MODEL_DIR = os.environ.get("MODEL_DIR", "/models")
MAX_TEXT = 500

kokoro = Kokoro(f"{MODEL_DIR}/model.onnx", f"{MODEL_DIR}/voices.npz")
g2p = {b: en.G2P(british=b, fallback=espeak.EspeakFallback(british=b), unk="") for b in (False, True)}
# download_dir 下的 g2pW/ 是构建时下好的 g2pW 模型（fetch_models.py zh）。
piper = {v: PiperVoice.load(f"{MODEL_DIR}/piper/{name}.onnx", download_dir=MODEL_DIR) for v, name in PIPER_VOICES.items()}
# onnxruntime 一次合成就会用满所有核，同时合成几句并不更快，所以一次只合成一句。
lock = threading.Lock()


# Piper 的中文音素表不包含拉丁字母。混合语句逐段合成，避免 Mac、PC 等内容吞掉中文。
latin_span = re.compile(r"([A-Za-z][A-Za-z0-9]*(?:[ '\u2019-]+[A-Za-z][A-Za-z0-9]*)*)")


def english_audio(text: str, voice: str):
    phonemes, _ = g2p[VOICES[voice]](text)
    return kokoro.create(phonemes, voice=voice, is_phonemes=True)


def chinese_audio(text: str, voice: str):
    chunks = [chunk.audio_float_array for chunk in piper[voice].synthesize(text)]
    if not chunks:
        raise ValueError("Chinese speech produced no audio")
    return np.concatenate(chunks), piper[voice].config.sample_rate


def mixed_audio(text: str, voice: str):
    """Preserve the order of Chinese and English spans in a single 24 kHz track."""
    segments = []
    rate = 24000
    for part in latin_span.split(text):
        if not part.strip():
            continue
        if latin_span.fullmatch(part):
            samples, source_rate = english_audio(part, "af_heart")
        elif re.search(r"[\u3400-\u9fff0-9]", part):
            samples, source_rate = chinese_audio(part, voice)
        else:
            continue
        if len(samples) == 0:
            raise ValueError("Speech segment produced no audio")
        if source_rate != rate:
            size = max(1, round(len(samples) * rate / source_rate))
            samples = np.interp(
                np.arange(size) * source_rate / rate, np.arange(len(samples)), samples
            ).astype(np.float32)
        segments.append(samples)
    if not segments:
        raise ValueError("Speech produced no audio")
    return np.concatenate(segments), rate


def synthesize(text: str, voice: str) -> bytes:
    with lock:
        if voice in piper:
            audio, rate = mixed_audio(text, voice) if latin_span.search(text) else chinese_audio(text, voice)
        else:
            audio, rate = english_audio(text, voice)
    buf = io.BytesIO()
    sf.write(buf, audio, rate, format="MP3")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.reply(200, b'{"status":"ok"}', "application/json")
        else:
            self.reply(404, b"not found")

    # POST /speak {"text": "...", "voice": "af_heart"} → MP3（voice 是 VOICES 或 PIPER_VOICES 里的名字）
    def do_POST(self):
        if self.path != "/speak":
            return self.reply(404, b"not found")
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            text, voice = str(body["text"]).strip(), body["voice"]
        except (ValueError, KeyError, TypeError):
            return self.reply(400, b"bad request")
        if (voice not in VOICES and voice not in piper) or not text or len(text) > MAX_TEXT:
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
    for v in piper:
        synthesize("准备好了。", v)
    print("vocab-tts 已启动，端口 8880", flush=True)
    ThreadingHTTPServer(("", 8880), Handler).serve_forever()

