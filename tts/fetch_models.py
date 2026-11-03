# 构建镜像时下载 Kokoro 的模型和声音，放到 /models（用法：python fetch_models.py /models model|voices）：
#   - model：model.onnx，onnx-community/Kokoro-82M-v1.0-ONNX 的 fp32 模型（hexgrad/Kokoro-82M 转成的 ONNX），300 多 MB。
#   - voices：voices.npz，同一个仓库 voices/ 下用到的几个声音，每个是 510×256 的 float32，按 kokoro-onnx 要的格式合成一个文件。
# 两样分两步下载（Dockerfile 里是两个 RUN），声音下载失败时重新构建不用再下一遍模型。
# HF_ENDPOINT 可以换成国内的 HuggingFace 镜像。
import os
import sys

from download import download

endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
repo = f"{endpoint}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main"
out, part = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

if part == "model":
    download(f"{repo}/onnx/model.onnx", f"{out}/model.onnx")
elif part == "voices":
    import numpy as np

    from voices import VOICES

    voices = {}
    for v in VOICES:
        download(f"{repo}/voices/{v}.bin", f"{out}/{v}.bin")
        voices[v] = np.fromfile(f"{out}/{v}.bin", dtype=np.float32).reshape(-1, 1, 256)
        os.remove(f"{out}/{v}.bin")
    np.savez(f"{out}/voices.npz", **voices)
else:
    sys.exit("第二个参数要是 model 或 voices")
