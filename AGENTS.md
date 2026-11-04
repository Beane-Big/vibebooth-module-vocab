# 背单词（vocab）模块约定（给 AI 编码工具和自己看）

这是一个 Vibebooth 模块，遵循模块规范 `platform: 1`：https://github.com/Beane-Big/vibebooth/blob/main/docs/module-spec.md 。不符合规范时 `npm run pack` 会直接报错。下面是本模块自己的约定。

- 模块 id 是 `vocab`：页面在 `/apps/vocab/` 下，接口在 `/api/vocab/` 下，容器叫 `vocab-frontend` 和 `vocab-backend`。
- 不要自己写网关路由标签、端口映射或网络，安装器会补上；`compose.yaml` 允许的字段见规范。
- 图标只有一份：根目录的 `icon.svg`（`module.yaml` 里的 `icon`）。平台主页、浏览器页签和 iOS 添加到主屏幕都用它，构建前端时自动复制一份、再画成 iOS 用的 `apple-touch-icon.png`（React 和 Vue 由 `frontend/vite-icon.ts` 做并写进 `index.html`，纯静态页面由 `frontend/touch-icon.mjs` 做）。不要在 `frontend/` 里另放图标或手写图标链接；图标里不要用 `<text>`，文字先转成路径。
- 不写登录代码。后端用 SDK `github.com/Beane-Big/vibebooth/packages/sdk-go/auth` 拿当前用户。
- 接口权限：要按人控制“能做什么”（例如编辑、清空）时，在 `module.yaml` 的 `permissions` 里声明，后端用 `auth.UserFrom(ctx).Has("<权限 id>")` 检查；没有声明功能权限时用 `HasMenu("<菜单 id>")`。不要用角色判断。前端用 `platform.ts` 的 `can(me, "<权限 id>")` 隐藏没权限的按钮，但真正的检查在后端。
- 前端和平台打交道（取当前用户、权限）只经过 `frontend/src/platform.ts`（纯静态页面是 `public/platform.js`），不要在别处直接请求 `/me`。
- 人员（家庭成员）由平台保存，不要在模块里另建人员表：用平台的对外接口 `http://core:8080/api/platform/ext/v1/` 只读地取人员名单，模块只保存人员 id。显示人员时带上 `?viewer=<令牌里的 sub>`，用返回的 `displayName`（每个人给别人写的备注优先，没写时是姓名）。模块不能改人员资料和头像。
- 词库内置只读：`backend/deck/core.json` 由 `npm run deck`（`scripts/build-deck.mjs`）从 ECDICT、CMUdict、Britfone 和 Tatoeba 生成，提交到仓库，用 `go:embed` 打进后端镜像；不要手改这个文件，要改选词或例句规则就改脚本重新生成。同一个脚本还生成 `backend/deck/dict.json`：例句里出现的每个词的美音、英音音标和释义，点例句里的词弹出的气泡（`frontend/src/components/WordPopup.tsx`）通过 `GET /api/vocab/lookup` 查它。音标一律来自开源发音词典（美音 CMUdict、英音 Britfone，`scripts/phonetics.mjs`），只换写法、不自己拼读音，词典里没有的词就不显示音标；词条和例句都带 `us`、`uk` 两份，前端按口音设置显示（`phOf`），例句的整句音标按设置 `sentencePh` 显示。Tatoeba 凑不够的例句写在 `deck/extra.json`（`{"单词": [{"en": "...", "zh": "..."}]}`），生成时排在 Tatoeba 后面。来源和许可证只写在 `backend/deck/NOTICE.md`（模块自用，页面上不显示署名），换数据源时一起改。
- 每个人的进度按令牌里的 `sub` 存（`settings`、`progress`、`plans`、`cards`、`answers`、`wrongs`、`tests` 表），后端从不从请求里读用户 id，家人之间互相看不到。复习记录按单词本身（不是序号）保存，词库重新生成、序号变了也接得上。
- 学习流程：学习计划（按序号往下取词，每个词 2–5 条例句）→ 计划测试 → 答错进错题本；计划测试的结果算作每个词的第一次复习，之后由 FSRS（`go-fsrs`，按天复习，不用短期步骤）安排每日复习。检测答错的词提前到明天复习，答对的不改计划。错题本里连续答对 `wrongClear` 次移出。这些规则都在 `backend/store.go` 的 `Record`。
- “今天”按浏览器时区算：前端在请求里带 `tz`（`getTimezoneOffset()` 的分钟数），不带时按北京时间。
- 导航只有一个组件 `components/Nav.tsx`（在 `App.tsx` 里渲染，页面里不要再放顶栏）：宽屏是顶部居中的毛玻璃胶囊，手机宽度（≤600px）是底部悬浮的毛玻璃标签栏，`.content` 底部留出它的高度；新增一级页面时改 `Nav.tsx` 里的 tabs。图标统一用 `components/Icon.tsx`。
- 朗读（`frontend/src/speech.ts`）：英文用模块自带的 Kokoro 语音，不接外部语音服务。容器 `vocab-tts`（`tts/`，Python）合成 MP3，后端 `GET /api/vocab/tts`（`backend/tts.go`）把结果存在卷里的 `tts/` 目录，同一句只合成一次、所有人共用；只合成词库里的词、例句和 `dict.json` 里的词。语速在前端播放时调（`playbackRate`）。中文、以及语音容器不可用时（独立模式没有这个容器）用浏览器的 `speechSynthesis`。声音列表在 `tts/voices.py`、`backend/tts.go`、`speech.ts` 三处，要一起改。锁屏后浏览器会停止朗读，自动播放在切到后台时暂停。`speak` 返回这句读了几秒，自动播放按它乘设置里的倍数停顿（`pauseBy`/`pauseRatio`，或固定秒数 `autoPause`）。
- 朗读服务的模型在构建镜像时下载（`tts/fetch_models.py`），`tts/Dockerfile` 用 `ARG PIP_INDEX_URL`、`ARG HF_ENDPOINT`、`ARG SPACY_MODEL_URL` 换下载源，不要删。
- 后端必须保留 `GET /api/vocab/health`，正常时返回 2xx。
- 数据只存在 `compose.yaml` 里声明的卷里，默认用 SQLite。改表结构要兼容老数据。
- 要调用其他模块，只调用对方 `/api/<id>/ext/v1/` 下的对外接口，并在 `module.yaml` 的 `requires` 里写上对方。
- 要换模块 id 或名称，运行 `npm run rename -- <新 id> [新名称]`，不要手动全局替换。装到平台以后就不要再改 id。
- 发布新版本前把 `module.yaml` 的 `version` 改大，再运行 `npm run pack`，或者 `npm run pack:source` 后上传到平台的构建器。
- 后端加了 Go 依赖不用在本机运行 `go mod tidy`，构建镜像时会补齐；Dockerfile 里的 `ARG GOPROXY`、`ARG NPM_REGISTRY` 和缓存挂载不要删，服务器构建靠它们换镜像源、复用下载过的依赖。

## 和平台耦合的等级

当前等级：2（认人）

模块和平台耦合多深分成 5 级，规则见模块规范里的“和平台耦合的等级”。只用到当前等级为止的平台契约，不要越级。要升级时在本目录运行下面的命令，它只加文件；已经改过的文件不覆盖，而是打印要手工加的内容。升级后这一行会跟着改。

| 等级 | 用到的平台契约 | 升级命令 |
| --- | --- | --- |
| 0 纯前端 | 无 | |
| 1 加后端、2 认人 | 网关注入的令牌（SDK 校验），令牌里的账号 id 和名字 | `npx github:Beane-Big/create-vibebooth add backend`，要存数据再 `add data` |
| 3 分权 | 令牌里的 `menus` 和 `perms`，`module.yaml` 的 `menus` 和 `permissions` | `npx github:Beane-Big/create-vibebooth add permissions` |
| 4 用平台数据 | 平台的人员接口 `http://core:8080/api/platform/ext/v1/` | `npx github:Beane-Big/create-vibebooth add persons` |

离开平台也能运行：`npm run standalone`。后端开独立模式（环境变量 `STANDALONE=1`），所有请求都当成一个拥有全部权限的本地用户；不要在 `compose.yaml` 里设这个变量，装到平台里时 SDK 会拒绝请求。第 4 级在独立模式下取不到平台的人员，要自己降级（`backend/persons.go` 里有示例）。
- 样式：全局的玻璃变量（`--glass`、`--glass-strong`、`--blur` 等）和背景色块 `.backdrop` 在 `frontend/src/styles.css`；页面共用的分段选择、图标选项格、小标签、结果环、空状态在 `pages/pages.module.css`（结果环是 `components/Ring.tsx`）。
