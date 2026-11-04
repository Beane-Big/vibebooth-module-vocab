# 背单词

按计划背英语单词，每个词配例句，自动复习和错题本

这是一个 [Vibebooth](https://github.com/Beane-Big/vibebooth) 模块，由 `create-vibebooth` 生成。

## 功能

- **学习计划**：从核心 3000 词里按词频顺序往下学，学几个词、每个词几条例句（2–5 条）、从第几个词开始都在设置里改，首页一键开始。卡片版式是单词页加例句页，卡片撑满屏幕，可以跟着手指左右拖着翻，也可以自动播放（英文读几遍、读不读中文、每句后停多久都能设；停顿默认和这句的朗读时长一样长，也可以改成固定秒数）。
- **计划测试**：学完自动进入，只测这批词，四种题型可选：听音想意思、看词想意思、看中文说英文、听写。
- **每日复习**：学过的词按遗忘规律（FSRS）安排复习，四档自评。
- **检测**：自己选范围（最近 7 天、序号范围、全部学过的、错题本）和题型，记录正确率。
- **错题本**：答错的词自动进来，连续答对几次后移到“已攻克”。
- 家里每个人的进度、设置和记录各自独立。

## 词库

`backend/deck/core.json` 是生成好的词库，提交在仓库里，构建镜像不需要联网下载。要更新时运行 `npm install` 再 `npm run deck`：脚本下载 ECDICT、CMUdict、Britfone 和 Tatoeba 的原始数据到 `.cache/deck/`，按词频取前 3000 名，每个词挑最多 5 条中英例句。来源和许可证见 `backend/deck/NOTICE.md`。

## 朗读

英文用模块自带的 Kokoro 语音（容器 `vocab-tts`，代码在 `tts/`）合成，后端把每句的 MP3 存在卷里，全家共用；中文用浏览器朗读。模型在构建镜像时下载，镜像约 1GB。

导航栏的液态玻璃效果用 [liquidglass](https://github.com/ybouane/liquidglass)（MIT，内含 html-to-image，MIT），浏览器不支持 WebGL 时用 CSS 毛玻璃。

构建时要下载 Python 包、HuggingFace 上的模型和 GitHub 上的 spaCy 英文模型。服务器在国内时，在构建器设置里加这些构建参数（不加就用官方源）：

| 参数 | 例子 |
| --- | --- |
| `PIP_INDEX_URL` | `https://pypi.tuna.tsinghua.edu.cn/simple` |
| `HF_ENDPOINT` | `https://hf-mirror.com` |
| `SPACY_MODEL_URL` | en_core_web_sm 的 wheel 在镜像里的地址（3.8.0 或 3.7.1 都行，hf-mirror 上是 3.7.1），GitHub 能连上时不用填 |

## 常用命令

都在本目录运行，需要 Node.js。

### 发布：推荐交给平台的构建器打包

| 命令 | 需要 | 做什么 |
| --- | --- | --- |
| `npm run pack:source` | 只要 Node.js | 把源码打成 `dist/vocab-<版本>-source.zip`（不含 `node_modules`、`dist`），上传到平台的“构建器”页面，由服务器构建出软件包，构建完在构建记录上点“安装” |

推荐用这种方式：本机不用装 Docker，镜像在服务器上构建，用的是构建器设置里的镜像源。前提是平台上已经装好构建器。GitHub 上的 “Download ZIP” 也可以直接上传给构建器。

### 本机打包和开发（可选）

| 命令 | 需要 | 做什么 |
| --- | --- | --- |
| `npm run pack` | Docker | 在本机构建镜像，生成 `dist/vocab-<版本>.zip`，上传到平台的“应用管理”页。平台还没装构建器时用 |
| `npm run install:local` | Docker 和本机平台 | 打包并装到本机平台，打开 http://localhost:8080 就能看到。改完代码再运行一次即可 |
| `npm run dev` | Docker 和本机平台 | 只启动前端开发服务器，接口转给本机平台，改界面时不用每次打包。先在 http://localhost:8080 登录一次，再打开终端里显示的地址 |

- 运行前先启动 Docker（Windows 和 Mac 上是 Docker Desktop）。
- “本机平台”指在平台仓库里用 `docker compose up -d` 跑起来的 Vibebooth。`pack` 不需要本机平台。
- `pack` 用安装器镜像检查并打包：本机有平台时用本机平台的，没有时下载发布版 `ghcr.io/beane-big/vibebooth-installer`，第一次要能连上 ghcr.io。镜像还是私有的话，先用有 `read:packages` 权限的令牌运行一次 `docker login ghcr.io`。
- 本机平台比模块旧时，`pack` 会用旧的安装器而报错（比如不认识新字段），先在平台仓库里 `git pull` 再 `docker compose up -d --build`。

### 离开平台单独运行

| 命令 | 需要 | 做什么 |
| --- | --- | --- |
| `npm run standalone` | Node.js；有后端时还要 Go | 后端开独立模式（不校验令牌，所有请求都当成拥有全部权限的本地用户，数据放在 `.data/`），前端开发服务器把接口转给它。打开终端里显示的地址，按 Ctrl+C 一起退出 |

独立模式只用来在本机开发和演示，不要在 `compose.yaml` 里设 `STANDALONE`：装到平台里时 SDK 会拒绝所有请求。

### 升级到下一级

在本目录运行 `npx github:Beane-Big/create-vibebooth add <backend | data | permissions | persons>`，说明见 `AGENTS.md` 的“和平台耦合的等级”。

### 其他

| 命令 | 做什么 |
| --- | --- |
| `npm run rename -- <新 id> [新名称]` | 改模块 id，也可以同时改名称，代码、配置和文档里用到的地方一起改。只改名称就把 id 写成原来的。id 要在第一次装到平台前定好：装过的模块改 id 会变成另一个应用，旧数据不会跟过去 |

依赖在构建镜像时下载（Go 用 `GOPROXY`，npm 用 `NPM_REGISTRY`），本机不用装 Go。

发布新版本前，把 `module.yaml` 的 `version` 改大。
