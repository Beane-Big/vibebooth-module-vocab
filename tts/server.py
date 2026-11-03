# 背单词的朗读服务：Kokoro-82M（Apache 2.0）用 onnxruntime 在 CPU 上把英文合成语音。
# 文字先用 misaki（Kokoro 官方的英文注音，Apache 2.0）转成音素：它有自己的美音、英音词典，按 spaCy 标出的词性挑同形词的读音；
# 词典里没有的词（多是人名）交给 espeak-ng。
# 只在模块内部网络里给后端调用，不对外，也不做缓存：后端把合成好的音频存在卷里，同一句只合成一次。
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro
from misaki import en, espeak

from voices import VOICES

MODEL_DIR = os.environ.get("MODEL_DIR", "/models")
MAX_TEXT = 500

kokoro = Kokoro(f"{MODEL_DIR}/model.onnx", f"{MODEL_DIR}/voices.npz")
g2p = {b: en.G2P(british=b, fallback=espeak.EspeakFallback(british=b), unk="") for b in (False, True)}
# onnxruntime 一次合成就会用满所有核，同时合成几句并不更快，所以一次只合成一句。
lock = threading.Lock()


def synthesize(text: str, voice: str) -> bytes:
    with lock:
        phonemes, _ = g2p[VOICES[voice]](text)
        audio, rate = kokoro.create(phonemes, voice=voice, is_phonemes=True)
    buf = io.BytesIO()
    sf.write(buf, audio, rate, format="MP3")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.reply(200, b'{"status":"ok"}', "application/json")
        else:
            self.reply(404, b"not found")

    # POST /speak {"text": "...", "voice": "af_heart"} → MP3
    def do_POST(self):
        if self.path != "/speak":
            return self.reply(404, b"not found")
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            text, voice = str(body["text"]).strip(), body["voice"]
        except (ValueError, KeyError, TypeError):
            return self.reply(400, b"bad request")
        if voice not in VOICES or not text or len(text) > MAX_TEXT:
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
    # 先合成一句，把模型和词典都加载好，第一次朗读不用等。
    synthesize("Ready.", "af_heart")
    print("vocab-tts 已启动，端口 8880", flush=True)
    ThreadingHTTPServer(("", 8880), Handler).serve_forever()
