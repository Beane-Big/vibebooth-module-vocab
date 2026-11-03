# 词库的数据来源

`core.json`（词库）和 `dict.json`（例句里点词查的小词典）由 `scripts/build-deck.mjs` 生成，用到以下数据：

- 单词、中文释义、词形变化和词频：[ECDICT](https://github.com/skywind3000/ECDICT)，MIT 许可证，Copyright (c) Linwei。释义经过整理（每个词性只留前 3 个义项）。
- 美音音标（`us`）：[CMUdict](https://github.com/cmusphinx/cmudict)，BSD 许可证，Copyright (C) 1993-2015 Carnegie Mellon University。
- 英音音标（`uk`）：[Britfone](https://github.com/JoseLlarena/Britfone)，MIT 许可证，Copyright (c) Jose Llarena。
- 两份音标都只换了写法（ARPAbet 换成 IPA、符号统一成牛津学习词典的写法、重音号放到音节开头），读音没有改动，规则见 `scripts/phonetics.mjs`。整句音标是句中每个词的词典读音连起来，虚词在句中用词典里收的弱读。
- 例句（`src` 为 `tatoeba:<句子 id>`）：[Tatoeba](https://tatoeba.org) 的英文句子和中文翻译，CC BY 2.0 FR 许可证，原作者见 `https://tatoeba.org/sentences/show/<句子 id>`。中文已用 OpenCC 统一转成简体，句子本身没有改动。
- 例句（`src` 为 `extra`）：`deck/extra.json` 里补充的句子，由本模块维护者整理。
