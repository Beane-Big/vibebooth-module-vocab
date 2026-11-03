# 下载一个 wheel 包，按包里写的名字和版本重新命名后放进目录（用法：python fetch_wheel.py <网址> <目录>）。
# pip 要求 wheel 的文件名带版本号；spaCy 模型在 HuggingFace 上叫 en_core_web_sm-any-py3-none-any.whl，直接装会被拒绝，
# 所以不管从哪个网址下载，都先改成 en_core_web_sm-3.8.0-py3-none-any.whl 这样的名字。只用标准库，装依赖之前就能跑。
import email.parser
import os
import sys
import zipfile

from download import download

url, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
tmp = os.path.join(out, "download.tmp")
download(url, tmp)
with zipfile.ZipFile(tmp) as z:
    meta = next(n for n in z.namelist() if n.endswith(".dist-info/METADATA"))
    info = email.parser.Parser().parsestr(z.read(meta).decode("utf-8"))
name = info["Name"].replace("-", "_")
os.replace(tmp, os.path.join(out, f"{name}-{info['Version']}-py3-none-any.whl"))
print("得到", name, info["Version"], flush=True)
