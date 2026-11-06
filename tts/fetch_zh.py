# 构建镜像时下载中文朗读要用的文件，放到 /models（用法：python fetch_zh.py /models）：
#   - piper/<名字>.onnx 和 .onnx.json：Piper 的中文声音（voices.py 的 PIPER_VOICES），60 多 MB。
#   - g2pW/：Piper 判断多音字用的 g2pW 模型，解压后 150 MB 左右。Piper 自己会在第一次合成时从 huggingface.co 下载，
#     这里先按 HF_ENDPOINT 下好，运行时不用联网。
#   - bert-base-chinese/：g2pW 用的分词表。把 g2pW/config.py 里的 model_source 改成这个目录，
#     运行时直接从本地读，不经过 huggingface_hub。
# 和 fetch_models.py 分开：改中文这部分不会让 Docker 重新下载 Kokoro 的模型。
#
# 大文件（存在 LFS 里的模型）用 resolve 地址，小文件（json、词表）用 raw 地址：
# huggingface.co 对小文件的 resolve 会再跳到 /api/resolve-cache/...，raw 不跳。
# hf-mirror 拒绝 User-Agent 为 Python-urllib 的小文件请求（返回 403），所以这里换一个名字。
# 只在这个脚本里换，不改 download.py：改它会让前面装依赖、下 Kokoro 模型的构建层缓存全部失效。
import os
import re
import sys
import tarfile
import urllib.request

from download import download
from voices import PIPER_VOICES

endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
out = sys.argv[1]

opener = urllib.request.build_opener()
opener.addheaders = [("User-Agent", "vibebooth-vocab-build/1.0")]
urllib.request.install_opener(opener)


def hf(repo: str, path: str, dest: str, big: bool = False) -> None:
    download(f"{endpoint}/{repo}/{'resolve' if big else 'raw'}/main/{path}", dest)


os.makedirs(f"{out}/piper", exist_ok=True)
for name in PIPER_VOICES.values():
    lang, speaker, quality = name.split("-")  # zh_CN、chaowen、medium
    path = f"{lang.split('_')[0]}/{lang}/{speaker}/{quality}/{name}"
    hf("rhasspy/piper-voices", path + ".onnx", f"{out}/piper/{name}.onnx", big=True)
    hf("rhasspy/piper-voices", path + ".onnx.json", f"{out}/piper/{name}.onnx.json")

tar = f"{out}/g2pw.tar.gz"
hf("datasets/rhasspy/piper-checkpoints", "zh/zh_CN/_resources/g2pw.tar.gz", tar, big=True)
with tarfile.open(tar) as t:
    t.extractall(f"{out}/g2pW", filter="data")
os.remove(tar)

bert = f"{out}/bert-base-chinese"
os.makedirs(bert, exist_ok=True)
for f in ("vocab.txt", "tokenizer.json", "tokenizer_config.json"):
    hf("google-bert/bert-base-chinese", f, f"{bert}/{f}")

config = f"{out}/g2pW/config.py"
with open(config, encoding="utf-8") as f:
    text = f.read()
text, n = re.subn(r"^model_source = .*$", f"model_source = {bert!r}", text, flags=re.M)
if n != 1:
    raise SystemExit(f"{config} 里没找到 model_source")
with open(config, "w", encoding="utf-8") as f:
    f.write(text)
