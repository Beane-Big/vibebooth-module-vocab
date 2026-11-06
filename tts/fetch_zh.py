# 构建镜像时下载中文朗读要用的文件，放到 /models（用法：python fetch_zh.py /models）：
#   - piper/<名字>.onnx 和 .onnx.json：Piper 的中文声音（voices.py 的 PIPER_VOICES），60 多 MB。
#   - g2pW/：Piper 判断多音字用的 g2pW 模型，解压后 150 MB 左右。Piper 自己会在第一次合成时从 huggingface.co 下载，
#     这里先按 HF_ENDPOINT 下好，运行时不用联网。
#   - g2pW 用的 bert-base-chinese 分词表，存在 HF_HOME 里，运行时离线读（huggingface_hub 也按 HF_ENDPOINT 找镜像）。
# 和 fetch_models.py 分开：改中文这部分不会让 Docker 重新下载 Kokoro 的模型。
import os
import sys
import tarfile

from transformers import BertTokenizer

from download import download
from voices import PIPER_VOICES

endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
out = sys.argv[1]
os.makedirs(f"{out}/piper", exist_ok=True)

for name in PIPER_VOICES.values():
    lang, speaker, quality = name.split("-")  # zh_CN、chaowen、medium
    url = f"{endpoint}/rhasspy/piper-voices/resolve/main/{lang.split('_')[0]}/{lang}/{speaker}/{quality}/{name}"
    for ext in (".onnx", ".onnx.json"):
        download(url + ext, f"{out}/piper/{name}{ext}")

tar = f"{out}/g2pw.tar.gz"
download(f"{endpoint}/datasets/rhasspy/piper-checkpoints/resolve/main/zh/zh_CN/_resources/g2pw.tar.gz", tar)
with tarfile.open(tar) as t:
    t.extractall(f"{out}/g2pW", filter="data")
os.remove(tar)

BertTokenizer.from_pretrained("bert-base-chinese")
