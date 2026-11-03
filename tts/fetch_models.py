# 构建镜像时下载 Kokoro 的模型和声音，放到 /models：
#   - model.onnx：onnx-community/Kokoro-82M-v1.0-ONNX 的 fp32 模型（hexgrad/Kokoro-82M 转成的 ONNX）。
#   - voices.npz：同一个仓库 voices/ 下用到的几个声音，每个是 510×256 的 float32，按 kokoro-onnx 要的格式合成一个文件。
# HF_ENDPOINT 可以换成国内的 HuggingFace 镜像。
import os
import sys
import urllib.request

import numpy as np

from voices import VOICES

endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
repo = f"{endpoint}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main"
out = sys.argv[1]
os.makedirs(out, exist_ok=True)


def get(path: str) -> bytes:
    print("下载", f"{repo}/{path}", flush=True)
    with urllib.request.urlopen(f"{repo}/{path}", timeout=60) as r:
        return r.read()


with open(f"{out}/model.onnx", "wb") as f:
    f.write(get("onnx/model.onnx"))
voices = {v: np.frombuffer(get(f"voices/{v}.bin"), dtype=np.float32).reshape(-1, 1, 256) for v in VOICES}
np.savez(f"{out}/voices.npz", **voices)
