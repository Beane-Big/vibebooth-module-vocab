# 词库的数据来源

`core.json`（词库）和 `dict.json`（例句里点词查的小词典）由 `scripts/build-deck.mjs` 生成，用到以下数据：

- 单词、中文释义、词形变化和词频：[ECDICT](https://github.com/skywind3000/ECDICT)，MIT 许可证，Copyright (c) Linwei。释义经过整理（每个词性只留前 3 个义项）。
- 美音音标（`us`）：[CMUdict](https://github.com/cmusphinx/cmudict)，BSD 许可证，Copyright (C) 1993-2015 Carnegie Mellon University。
- 英音音标（`uk`）：[Britfone](https://github.com/JoseLlarena/Britfone)，MIT 许可证，Copyright (c) Jose Llarena。
- 两份音标都只换了写法（ARPAbet 换成 IPA、符号统一成牛津学习词典的写法、重音号放到音节开头），读音没有改动，规则见 `scripts/phonetics.mjs`。整句音标是句中每个词的词典读音连起来，虚词在句中用词典里收的弱读。
- 例句（`src` 为 `tatoeba:<句子 id>`）：[Tatoeba](https://tatoeba.org) 的英文句子和中文翻译，CC BY 2.0 FR 许可证，原作者见 `https://tatoeba.org/sentences/show/<句子 id>`。中文已用 OpenCC 统一转成简体，句子本身没有改动。
- 例句（`src` 为 `extra`）：`deck/extra.json` 里补充的句子，给 Tatoeba 凑不满 5 条的词用，由 AI（Claude）按词写出、维护者抽查。

# 朗读用到的模型和程序

`tts/` 里的朗读服务（容器 vocab-tts）在构建镜像时下载这些，打包进镜像：

- 语音模型：[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) v1.0，Apache 2.0 许可证，ONNX 版本来自 [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)；用到其中的声音 af_heart（美音）、bf_emma（英音）。
- 英文注音：[misaki](https://github.com/hexgrad/misaki)，Apache 2.0 许可证；词性标注用 [spaCy](https://spacy.io) 和 en_core_web_sm，MIT 许可证。
- 词典查不到的词用 [eSpeak NG](https://github.com/espeak-ng/espeak-ng) 注音（GPL-3.0 许可证，作为独立程序在容器里运行）。
- 推理：[kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx)（MIT）和 [ONNX Runtime](https://onnxruntime.ai)（MIT）。
