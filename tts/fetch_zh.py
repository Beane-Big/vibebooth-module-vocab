# 构建镜像时下载中文（含中英混读）朗读要用的 Kokoro-82M-v1.1-zh 模型，放到 /models/kokoro-zh/（用法：python fetch_zh.py /models）：
#   - model.int8.onnx / voices.bin / tokens.txt / lexicon-us-en.txt / lexicon-zh.txt / *.fst：
#     来自 csukuangfj/kokoro-int8-multi-lang-v1_1（Apache 2.0），约 175 MB，原生支持中英同音色混读。
#   - 修复 lexicon-zh.txt 中以“地”结尾的词被误标为轻声（ㄉ ㄧ 5 → ㄉ ㄧ 4）的问题，并生成 lexicon-custom.txt：
#     1) 修正“目的 / 目的地 / 毫无目的地 / 盲目的 / 悦目的 / 打的 / 标的”等高频多音字词；
#     2) 用 misaki 补齐中文例句里常见但 lexicon-us-en.txt 缺失的英文缩写与专名（如 PC、CD、CEO、USB、iPad 等），避免被当作 OOV 跳过。
# 和 fetch_models.py 分开：改中文这部分不会让 Docker 重新下载 Kokoro 英文模型。
#
# 大文件（存在 LFS 里的模型和词典）用 resolve 地址，小文件（tokens、fst）用 raw 地址；
# hf-mirror 拒绝 User-Agent 为 Python-urllib 的小文件请求（返回 403），所以这里换一个名字。
import os
import sys
import urllib.request

from download import download

endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
out = sys.argv[1]
zh_dir = f"{out}/kokoro-zh"

opener = urllib.request.build_opener()
opener.addheaders = [("User-Agent", "vibebooth-vocab-build/1.0")]
urllib.request.install_opener(opener)

REPO = "csukuangfj/kokoro-int8-multi-lang-v1_1"


def hf(path: str, dest: str, big: bool = False) -> None:
    download(f"{endpoint}/{REPO}/{'resolve' if big else 'raw'}/main/{path}", dest)


os.makedirs(zh_dir, exist_ok=True)
for big_file in ("model.int8.onnx", "voices.bin", "lexicon-us-en.txt", "lexicon-zh.txt"):
    hf(big_file, f"{zh_dir}/{big_file}", big=True)
for small_file in ("tokens.txt", "date-zh.fst", "number-zh.fst", "phone-zh.fst"):
    hf(small_file, f"{zh_dir}/{small_file}", big=False)

# 1. 修复 lexicon-zh.txt 中名词性“*地”结尾被标成轻声（ㄉ ㄧ 5）的问题（如土地、当地、基地、目的地等）。
lex_zh_path = f"{zh_dir}/lexicon-zh.txt"
fixed_lines = []
fixed_count = 0
with open(lex_zh_path, encoding="utf-8") as f:
    for line in f:
        stripped = line.rstrip("\r\n")
        if " " in stripped:
            word, pron = stripped.split(" ", 1)
            if len(word) >= 2 and word.endswith("地") and pron.endswith("ㄉ ㄧ 5"):
                pron = pron[:-1] + "4"
                stripped = f"{word} {pron}"
                fixed_count += 1
        fixed_lines.append(stripped + "\n")
with open(lex_zh_path, "w", encoding="utf-8") as f:
    f.writelines(fixed_lines)
print(f"已修复 lexicon-zh.txt 中 {fixed_count} 条 '*地' 声调", flush=True)

# 读取有效音素表，确保自定义词典中的每个符号都合法。
valid_tokens: set[str] = set()
with open(f"{zh_dir}/tokens.txt", encoding="utf-8") as f:
    for line in f:
        parts = line.strip().split()
        if len(parts) == 2:
            valid_tokens.add(parts[0])

# 2. 中文多音字精准修正（后加载的 lexicon-custom.txt 会覆盖 lexicon-zh.txt / lexicon-us-en.txt）。
ZH_OVERRIDES = {
    "目的": "ㄇ ㄨ 4 ㄉ ㄧ 4",
    "目的地": "ㄇ ㄨ 4 ㄉ ㄧ 4 ㄉ ㄧ 4",
    "毫无目的地": "ㄏ ㄠ 2 ㄨ 2 ㄇ ㄨ 4 ㄉ ㄧ 4 ㄉ ㄜ 5",
    "盲目": "ㄇ ㄤ 2 ㄇ ㄨ 4",
    "盲目的": "ㄇ ㄤ 2 ㄇ ㄨ 4 ㄉ ㄜ 5",
    "悦目": "月 4 ㄇ ㄨ 4",
    "悦目的": "月 4 ㄇ ㄨ 4 ㄉ ㄜ 5",
    "醒目": "ㄒ 应 3 ㄇ ㄨ 4",
    "醒目的": "ㄒ 应 3 ㄇ ㄨ 4 ㄉ ㄜ 5",
    "瞩目": "ㄓ ㄨ 3 ㄇ ㄨ 4",
    "瞩目的": "ㄓ ㄨ 3 ㄇ ㄨ 4 ㄉ ㄜ 5",
    "打的": "ㄉ ㄚ 3 ㄉ ㄧ 1",
    "标的": "ㄅ 要 1 ㄉ ㄧ 4",
    "能干": "ㄋ ㄥ 2 ㄍ ㄢ 4",
    # 中文里单独出现的英文字母 A（如“第一个字母 A”、“A和B的区别”）读字母名 /eɪ/。
    "a": "ˈ A",
}

# 3. 补齐中文例句里出现但 lexicon-us-en.txt 缺失的英文缩写、品牌和专名，用 misaki 转成 Kokoro 音素。
EXTRA_EN_WORDS = [
    "PC", "CD", "CEO", "DNA", "MRI", "PDF", "PHP", "SSH", "SUV", "USB", "TV",
    "BB", "BDS", "BLT", "BMI", "CC", "CCAV", "CDMA", "JST", "NTT",
    "iPad", "Microsoft", "TOEFL", "CakePHP", "BraveSentry", "Tatoeba",
    "Karlo", "Layla", "Luke", "Marie", "Martyna", "Montero", "Omid",
    "Ronnie", "Sean", "Trang", "Conner", "Dio", "Garvey", "Gilmore",
    "Canis", "familiaris", "abazure", "aoke",
]

from misaki import en, espeak  # noqa: E402

g2p_us = en.G2P(british=False, fallback=espeak.EspeakFallback(british=False), unk="")

custom_entries: list[str] = []
for word, pron in ZH_OVERRIDES.items():
    toks = pron.split()
    unknown = [t for t in toks if t not in valid_tokens]
    if unknown:
        raise SystemExit(f"自定义中文词典 {word!r} 包含未知音素: {unknown}")
    custom_entries.append(f"{word} {pron}\n")

for word in EXTRA_EN_WORDS:
    phonemes, _ = g2p_us(word)
    # 去掉空白并过滤出模型词表支持的音素字符（保留空格作为词内/字母间停顿）。
    toks = [ch for ch in phonemes if ch in valid_tokens and ch != " "]
    if toks:
        custom_entries.append(f"{word.lower()} {' '.join(toks)}\n")

with open(f"{zh_dir}/lexicon-custom.txt", "w", encoding="utf-8") as f:
    f.writelines(custom_entries)
print(f"已生成 lexicon-custom.txt（共 {len(custom_entries)} 条）", flush=True)
