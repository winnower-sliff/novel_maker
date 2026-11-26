# novel_maker 项目须知

> v2 现状版，只写现在仍然成立的事实。演进过程与「当时为什么这么做」见 `docs/v2/HISTORY.md`；v1（Electron 版，代码在 tag `archive/v1`）的架构与踩坑见 `docs/v1/LEGACY.md`。

## 任务交接纪律（新会话先读）

- **开工前先看 `docs/v2/HANDOFF.md`**：有未完成任务就先续做，不接新需求。
- 长任务（多文件/多轮改动）**动手前**先写计划到 `docs/v2/HANDOFF.md` 再开工；每完成一步立即更新勾选与「下一步」（精确到文件与操作），不等全做完才写。
- 长任务每达成一个绿里程碑（typecheck + lint + 冒烟通过）就 commit——git 历史本身就是进度账。
- 任务完成（commit + push + 部署）后把 `HANDOFF.md` 清回空闲模板。

## 一页速览

- **产品**：Tailscale 局域网内的私人小说工坊。电脑端 = 纯 Node 常驻服务 + 系统托盘（无 Electron、无桌面窗口、无浏览器版），手机 APK 是唯一入口。
  「写小说」= 和导演 agent 聊天、做选择；正文等一切内容由 agent 调工具落库。版本号从 v3.0.0 起，v1 旧数据不迁移。
- **目录**：
  - `src/main/` 电脑端：`index.ts`（启动序列）、`server.ts`（HTTP + SSE）、`tray.ts`、`jobs.ts`（任务队列）、`db.ts` + `store.ts`（分叉树数据层）、`agent/`（`loop.ts` 循环与拦截工具、`tools.ts` CRUD 工具、`evidence.ts` 沉淀证据校验）、
    `director/`（`callJson.ts` LLM 调用与重试、`prompts.ts`、`context.ts` 写作简报、`storyRecap.ts` 前情梗概合并、`steps.ts`、`onboard.ts`）、`handlers/`（invoke handler 按域拆）、`backup.ts`、`lint.ts`、`config.ts`、`usage.ts`、`samples.ts`、`sampleParse.ts`（范文切节）、`llm.ts`、`llmOpenai.ts`、`broadcast.ts`、`eventSink.ts`（事件出口）、`connect.ts`（连接地址）、`paths.ts`（数据目录）、`serverState.ts`（服务状态）、`autostart.ts`（开机自启）、`buildInfo.ts`（构建指纹）
  - `src/shared/`：`contract.ts`（zod 契约，单一事实源）、`types.ts`、`providers.ts`（provider 预设与模型槽）
  - `mobile/`：手机端独立 vite 应用（React 19 + Tailwind v4 + TanStack Query + zustand），产物 `dist-mobile/`
  - `mobile-app/`：Capacitor 壳 + Android 工程（原生插件 `ApkUpdaterPlugin`、`ExportPlugin`、`AppRestartPlugin`）
  - `scripts/`：`deploy.mjs`、`build-apk.mjs`、`version.mjs`、`build-info.mjs`、`pack-mobile.mjs`、`prod-server.mjs`、`check-tailwind-classes.mjs`、`smoke-*.mjs`、`temp-dir.mjs`（冒烟的公共收尾：等子进程退出、删临时目录）
  - `docs/v2/`：`DECISIONS.md`（需求决策单一事实源）、`HANDOFF.md`、`HISTORY.md`；`docs/v1/LEGACY.md`
- **数据目录**：`%APPDATA%\novel-maker-v2`（其他平台 `~/.novel-maker-v2`；环境变量 `NM_DATA_DIR` 覆盖）。`novel.db` 是全部数据，`settings.json` 是配置与模型密钥，
  `imports\` 放待导入范文，备份与 APK 更新包也在这里。**与 v1 的 Electron userData 目录隔离**（v1 settings 含 safeStorage 密文与旧 schema，混读必炸）。
- **命令**（以 `package.json` 为准；Windows，Node ≥ 24）：

  | 命令 | 作用 |
  |---|---|
  | `npm run dev` | tsx watch 起 `src/main/index.ts` |
  | `npm run start` | 跑构建产物 `node dist/main/index.js`，前台常驻，Ctrl+C 退出。**先 `npm run build`**；只配临时数据目录用（`NM_DATA_DIR` 指到别处）——在跑着生产服务的 checkout 里直接运行，等于对生产数据目录再起一个实例：端口漂到 3911 看着没事，启动序列却照样清空草稿书、把运行中的任务标失败，还多出一个托盘图标 |
  | `npm run typecheck` | 两套 tsconfig：根（主进程，NodeNext）+ `mobile/tsconfig.json` |
  | `npm run lint` / `npm run lint:fix` | Biome 检查 / 修复（lint + format 一体），范围 = `src`、`mobile/src`、`mobile/vite.config.ts`、`scripts` |
  | `npm run build` | tsc → `dist/`，并写构建指纹 `dist/build-info.json` |
  | `npm test` | build + `scripts/smoke-all.mjs`（串行跑全部冒烟；`node scripts/smoke-all.mjs m6 sample` 只跑文件名含这些词的） |
  | `npm run verify` | typecheck + lint + test，即完整门禁 |
  | `npm run deploy` | 构建 → 停旧服务 → detached 拉起新服务 → 健康探测并校验指纹与 PID |
  | `npm run apk` | 出 APK：算版本 → 写 package.json → 确保生产 server 是最新构建 → 构建包 → 部署为更新源 → 全部成功才提交版本号并打 tag |

## 架构与约定

### 电脑端（`src/main/`）

- **启动序列**（`index.ts`）：`initConfig` → `startServer` → 清理空草稿书 → `recoverJobsOnBoot`（上个进程遗留的 running 标失败、可重试，queued 续跑）→ 看门狗每分钟巡检 → 每日备份（启动 15s 后 + 每 24h）→ 托盘（失败不致命）。未捕获异常只记录不退出。
- **HTTP**（`server.ts`）：监听 `0.0.0.0`，起始端口 3910（`settings.json` 的 `server.port`，被占则向后试）。端点：`POST /api/invoke/:channel`、`GET /api/events`（SSE）、`GET /api/health`（含构建指纹与 pid）、
  `GET /api/mobile/version` + `/api/mobile/apk`（APK 更新源）、`GET /api/export/:bookId`（整书 zip）。
- **无鉴权**（用户决策）：Tailscale 网络即信任边界，无密码 / token / 二维码。不要重新引入登录层。
- **invoke 形态**：body = `{"args":[元组]}`，zod 校验后 `handler(ctx, args)`——**元组整体传，绝不 spread**（`ArgsOf<C>` 是 zod 派生的元组，handler 统一收单元组再解构）。成功响应 `{result}`，失败 `{error}`（400）。`HandlerTable` 全部从契约派生。
- **LLM**：统一 OpenAI 协议（`llmOpenai.ts`，`/v1/chat/completions` 流式）。provider 预设 glm / deepseek / custom，模型槽 director / writer / reviewer / utility（`src/shared/providers.ts`）。
  结构化调用走 `director/callJson.ts`（`callRaw` / `callJson`）：网络与 5xx 指数退避重试 2 次，429 读 retry-after（≤60s）重试 1 次，流 120s 无新数据视为中断、可重试；**每次请求都经它 `appendUsage` 记账**。
  思考模式默认关闭（思考 token 计入 max_tokens），仅 chat 链路开启。API Key 存 `settings.json`，`settings:save` 只写不读、回读掩码。
- **模块纪律**：tsc 直出 ESM、无 bundler，`module=NodeNext`——相对 import 必须带 `.js`，目录导入要写到文件（`./handlers/index.js`）。两套 tsconfig 都是 `strict` + `noUncheckedIndexedAccess` + `erasableSyntaxOnly`（不写 enum、参数属性这类不可擦除语法）。
- **数据层**（`db.ts` + `store.ts`）：内置 `node:sqlite`，**一律不用原生模块**。表：books / lines / chapters / chapter_versions / cards / characters / foreshadows / memories / messages / jobs / samples / sample_sections。
  `SCHEMA_VERSION`（`PRAGMA user_version`，现为 2）——改表结构或 migrate 时 +1，老库升级前自动留快照。
- **分叉树**：每本书一条激活线，可从任意章之后开新线；不分卷、不合并、无状态机、无真删除（一切重来 = 分叉）。
  - `effectiveChapters(lineId)` = 祖先线 fork 点前的章节 + 本线章节按序拼接，是分叉树的核心读操作。`lines.fork_order` 记录分叉点序号，分叉点章不在时子线仍保住更早的祖先章；起点章不可删。
  - **「第 N 章」= 本线有效章序列里的位置**：本线自己的章序号（`order_no`）从 1 重排，跨线不可比——要定位一章用章节 id。
  - `forkLine` 在事务里深拷贝 cards / characters / foreshadows，设定各线独立演化；前情梗概在覆盖范围没越过分叉点时一并带过去，各线此后独立演化。
  - 删除（删书 / 线 / 卡 / 人物 / 伏笔）前自动 `snapshotDb` 留快照；归档 = `book:update {archived:true}`（内容全保留），彻底删除走 `book:delete`（带确认参数）。
- **数据安全**（`backup.ts`）：每日一份 gzip 备份（近 7 天全留，更早每周 1 份共 8 桶）；删除前快照只留最新 30 份，manual / pre-migrate / pre-restore 永不自动清。
  `backup:list / create / restore`——恢复是进程内换库，先留 pre-restore 快照，失败自动换回；手机入口在设置页「备份与恢复」。`settings.json` 原子写（tmp → rename），损坏时改名 `settings.json.corrupt-<时间>` 保全后用默认值。

### 任务与 agent 写章链路

- **任务**（`jobs.ts`）：kind = write / onboard / rewrite / revise / review / audit / diagnose / chat。全局串行队列（先来后到），**启动接口一律入队即返回**——等整轮会让手机 30s 超时报「发送失败」。
  取消与看门狗经 `AbortSignal` 真正中止在跑的请求，终态写入带 `WHERE state='running'`（取消不被 done 覆盖）；running 超 10 分钟无进展标 failed。
- **聊天时间轴**：`messages` 表是单一事实源，`meta.kind` = action（用户动作）/ chat（导演白话）/ thinking（思考）/ tool（工具卡）/ job（节点卡）。事件五个：
  `job:update`、`job:activity`（工具卡）、`job:progress`（正文 / 改章字数）、`job:delta`（白话与思考的流式增量，带累计长度 total）、`message:append`。
  **正文、改章等一切生成内容不进聊天流**——agent 一律调工具产出，聊天里只有对话、思考、工具卡和成品卡（入书卡）。流式内容周期落进 job 的 `payload.answer` / `payload.draftText`，服务端是唯一真相源。
- **写章**（走向卡已废除，用户决策：聊天驱动、agent 自主定走向）：`job:startWrite [bookId, hint?]` → 若书开了 `planMode`，先出本章计划书并停在 `waiting_user`（step = `plan`），
  `job:approvePlan [jobId, feedback?]` 后入队 → `runAgentLoop(mode:'chapter')`：`get_write_context` → `write_chapter_draft` → lint 自检（major 自动修一轮）→ `commit_chapter` → 沉淀（`save_card` / `patch_character_state` / `save_foreshadow`）→ `finish`。
  沉淀必须带证据：写章任务里 `save_card` / `save_foreshadow` 要附本章原句（`evidence`），服务端核对原句确在正文里才落库（见 `agent/evidence.ts`）；聊天模式由作者点名，不强制。
  有效章数每满 8 章自动排一次后台审计（章数 < 2 不审计）。**写完停手**，agent 不自动续写。
- **前情梗概（长期记忆）**（`director/storyRecap.ts`）：每条线一行 `running` 梗概（`memories.kind`），新章入书后把新章纪要并进去、**原地更新**，
  固定四段（主线脉络 / 伏笔状态·已埋已回收 / 人物关系 / 时间地点），目标 1500 字、超 2200 字先让模型压一次、仍超硬截。
  全部 fire-and-forget：失败只记日志并冷却 60 秒，绝不让写章任务失败；同一条线同时只跑一个合并循环。
  没有梗概（或落后于章）时，`get_write_context` / `delete_last_chapter` 之后在后台补建；删末章盖到梗概时删行待重建，不做「反合并」。
  旧的逐章压缩块（`kind=legacy`）只读保留、不再新增，仅在首次合并时当参考材料、没有 `running` 时回退注入。
  改稿（`revise_chapter` / `job:startRevise`）成功后同样走后台：按新正文重写该章纪要，再对梗概做增量合并。
- **写作简报**（`director/context.ts` 的 `buildStoryBrief`）：导演与写手共用同一份上下文——钉选设定 → 前情梗概 → 人物现状 → 未闭合伏笔 → 本章出场人物人设 → 相关设定卡 → 近 8 章纪要 → 已批准的本章计划。
  写手动笔前传本章大纲作 focus，会多带出场人物的人设（`characters.data`，最多 6 人）与相关设定卡（非钉选里本章提到的，带完整 `data`，最多 5 张）；`books.styleSample` 作「文风范例」放在写手提示末尾。
- **agent 循环**（`agent/loop.ts`）：`maxTurns` 30；每轮重建系统提示，注入书的基础信息、红线、正负词、文风与记忆简报（前情梗概 + 主要人物名单），稳定内容在前、动态在后（DeepSeek 前缀缓存按前缀命中），防长程遗忘。流式拦截工具 `finish` / `write_chapter_draft` / `commit_chapter` / `revise_chapter` / `spawn_subagent` 内联在 loop.ts；
  普通 CRUD 工具在 `agent/tools.ts`（读 / 写 / 删 / 线操作四类），返回 `{ok, summary, data}`——summary 给作者的工具卡，data 给 LLM（上限 30000 字）。
  - free 模式（`job:startChat`，历史取最近 12 条 chat 消息）没有写章权限：意图工具 `propose_chapter` / `request_review` / `request_audit` 转成排队任务或文本回报。
    纪律：涉及书里已发生的事先查再答，查不到就明说不确定；作者表达的长期偏好当轮存成钉选卡；开书引导定下的终局方向也落库为钉选卡「终局方向」。
  - `revise_chapter` 默认局部替换（未点名处一字不动），直接替换旧版、不留档；作者明确要求才整章重写。
  - `spawn_subagent` 是只读调查员（只带读工具、最多 12 轮、只回报结论）。要翻大量资料但只要结论时派它去。
- **自检与落库语义**（`lint.ts`）：书级负向词（`books.negative_words`）命中即 major，正向词只提示。save_* 工具按**部分更新**语义工作：未传的字段保持原值（详见踩坑 3）。
- **LLM 生成只走 agent**：新写作能力一律做成 agent 工具或拦截工具；手机页面只做手动操作与只读展示（正文无编辑器）。范文库（`samples.ts`：txt 导入、书级绑定、`read_sample`）供 agent 翻阅。

### 手机端（`mobile/`）

- 页面：Connect / Shelf / Onboard / BookWorkspace（写作·阅读·设定·线）/ Read / Cards / Lines / Settings，写作页拆在 `pages/write/`。连接地址在 `lib/conn.ts`（`DEFAULT_BASE_URL` = Tailscale IP:3910，连接页可改）。
- `lib/bridge.ts`：`buildApi(transport)` 跑在 fetch + 单例 `EventSource('/api/events')` 上；invoke 带 30s 超时；SSE 断成 CLOSED 后手动退避重建并派发 `nm-sse-reconnect`。
- 数据层 = TanStack Query（`lib/queries.ts`，写后按 key 失效）；UI 态 = zustand（`uiStore`、`tickerStore`、`conn`）。query 结果按可空处理（`.data?.x`）。
- 流式恢复：前端收到的 delta 长度与 total 失配时用 `job.get` 补拉，不要在前端自行拼接猜测。
- 样式：Tailwind v4 的唯一扫描源 = `mobile/src`（vite root，无 `@source`）；`styles.css` 用了 `@apply`。
- 原生插件（`mobile-app/android/app/src/main/java/com/novelmaker/mobile/MainActivity.java`）：**`registerPlugin` 必须写在 `super.onCreate` 之前**，否则报 plugin is not implemented。
- **新增契约通道**：① `src/shared/contract.ts` 加 zod 通道 + `Api` 接口方法（有覆盖率断言，漏一个编译报错）；② `src/main/handlers/` 对应域文件用 `Pick<HandlerTable, …>` 标注，并在 `index.ts` 汇总；③ 写 handler 本体。客户端方法由 `buildApi` 自动派生。

### 部署、发布、门禁

- **生产 server 跑的是主 checkout 的 `dist/main/index.js`**（`C:\Users\14270\.local\share\opencode\worktree\754ca1\v2-rebuild`，分支 feat/v2-rebuild）。**开发线（worktree）里绝不 `deploy` / `apk`**——会让生产寄生在待删的目录上，还会打 tag 推版本。开发线只靠冒烟验证，合并回主 checkout 后再部署。
- **判断生产是否落后**：比对 `GET /api/health` 的 `build.sourceHash` 与 `node scripts/build-info.mjs --print`（指纹 = `src/main` + `src/shared` 全部 .ts 的内容哈希）。
  不要拿 health 的 version 跟 `package.json` 比——出包后才 bump 版本号，那个判据恒成立。
- `npm run deploy`：有写作任务在跑时拒绝重启（`--force` 强行，任务会被标 failed）；`--if-stale` 指纹一致则不动；仅支持 Windows。
- **停止服务没有命令**，三条路：① 托盘菜单「退出」——关 HTTP、关托盘、exit 0，最干净；② 前台起的（`npm run start` / `npm run dev`）按 Ctrl+C，走同一条 SIGINT 收尾；③ `npm run deploy` 拉起的实例没有控制台，只能按 PID 强杀——PID 在数据目录的 `server.pid`（deploy 写的）或 `GET /api/health` 的 `pid`，`taskkill /F /T /PID <pid>`（Git Bash 里加 `MSYS_NO_PATHCONV=1`）。
  强杀没有收尾，下次启动时 `recoverJobsOnBoot` 把被打断的任务标 failed（可重试）。升级不用手动停：`npm run deploy` 自带停旧服务。
- `npm run apk`（`build-apk.mjs`）：先 `deploy --if-stale` 再出包（`--skip-deploy` 跳过），只能在跑生产 server 的 checkout 里执行。链路 = vite build → Tailwind 哨兵 → `sync-bundle` → `cap sync` → `gradlew assembleDebug` → 根目录 `NovelMaker.apk` → `pack-mobile` 部署为更新源。
  **出包前先装 `mobile-app` 的依赖**：`cd mobile-app && npm ci`。Android 壳是独立的 npm 包（有自己的 `package.json` / `package-lock.json`），根目录 `npm ci` 装不到，`build-apk.mjs` 也不代劳——`npx cap sync android` 与 gradle 都在 `mobile-app` 下跑，读的是那里的 `node_modules`，没装就在 `cap sync` 这步失败。
  **只改主进程的提交不出 APK**（内容相同的包只会白白打断用户安装）；手机端有改动才出包。
- **版本号**：根 `package.json` 的 `version` 是 semver 单一事实源。`scripts/version.mjs` 按 Conventional Commits 自最新 `v*` tag 推进（breaking → major、feat → minor、fix / perf → patch，其余不升），出包全部成功才提交 `chore(release): vX` 并打 tag。
  APK 的 `versionCode` = 分钟级 epoch 的 int（单调递增，手机端判新只看它），`versionName` = `<semver>-<yyyymmddHHMM>`。
- **门禁** = `npm run verify` 全绿。改主进程代码后必须部署才生效。
- **冒烟**（`scripts/smoke-*.mjs`，打的是 `dist`，须先 build）：每套自带临时数据目录（`NM_DATA_DIR`）与测试端口（3955–3986），**不碰 3910 上的生产服务**；总入口串行、单套 6 分钟超时；输出很长，后台跑并重定向后只看尾部。
  临时目录建在 `%LOCALAPPDATA%\Temp`（`nm-` 前缀），每套用完自己删——公共收尾在 `scripts/temp-dir.mjs`（先等子进程退出、关本进程的 sqlite 句柄，再删；被占用就重试）。
  总入口每套跑前 / 跑后比对 Temp 下的 `nm-*` 目录，留下没删的点名并判该套失败。
  - LLM 桩（`smoke-m3-stub.mjs` 端口 3923、`smoke-llm-stub.mjs` 端口 3922）是**队列式**的：每来一次 `/v1/chat/completions` 弹出下一个预设响应，调用顺序一变就全盘错位。改 prompt 步数或增减工具调用轮，都要同步改队列。
    后台记忆调用（前情梗概合并 / 改稿后重写章纪要，身份行在 `director/storyRecap.ts`）与主链路并发到达、顺序不定，走桩的**旁路应答**（按系统提示的身份行识别，不吃队列）；新增后台模型调用照此办理，不要去关功能迁就队列。
  - `smoke-memory.mjs` 不起 dist 服务：直接调 dist 模块，模型请求打到脚本内的桩（端口 3980），合并是否落库靠 `storyRecapSettled()` 等待。
  - 桩开关：`SKIP_ONBOARD=1`（已开书续写）、`CHAT_FIRST=1`、`CHAT_IN_QUEUE=0`、`AGENT_MODE=1`、`PLAN_MODE=1`、`SUBAGENT=1`。带 LLM 的冒烟脚本要设 `negativeWords`（如 `['忽然']`）触发自动修轮，否则队列错位。

## 踩坑记录（v2 仍会踩）

1. **systray 1.0.5**：CJS 老包，ESM default import 拿到的是 `module.exports`，构造函数在 `.default` 上——`tray.ts` 手写窄接口 + 运行时解包，勿改回 `import SysTray from 'systray'` 直接 `new`。
2. **zod4**：`z.record(enumKey, V)` 表示枚举的每个键都必需；要 partial 语义必须用 `z.partialRecord`（`SettingsPatchSchema` 的 profiles / apiKeys / routing 中过招）。
3. **save_* 部分更新要三层同步**：store 层 `input.x ?? old.x` 兜底还不够——`contract.ts` 的 InputSchema 若仍 `min(1)` 必填，HTTP invoke 链路照样拒；tools.ts 入参用 `typeof x === 'string' && x ? x : undefined` 防空串穿透。新 save 工具 / 通道必须遵守这套语义。起因：AI `save_character` 只传 id 没传 name，把人物名清空。
4. **`forkLine` 的 `COPY_COLUMNS` 写死列名**：给 cards / characters / foreshadows 改表列，必须同步这份白名单，否则新线丢字段（m2 冒烟实锤）。
5. **思考吃满输出预算 = 静默空响应**：`finish_reason=length` 且无正文无工具时不要静默退出——loop.ts 推 nudge，补救轮 maxTokens 翻倍，2 次仍空才返回可见错误。判据：usage 的 out 恰好等于上限值。
6. **「光说不练」**：白话承诺「这就改」但本轮没有工具调用，会直接结束任务——loop.ts 用正则识别并强制追问（最多 2 次）。
7. **APK 自更新按 versionCode 隔离**：下载文件名曾固定，旧包残留字节数 ≥ 新包时被 size 判据误判「已完整」，反复装旧版。现下载 / 状态 / 安装都带 versionCode，文件存 `nm-<vc>.apk`。完整性判据不能只比 size，必须绑定版本身份。
8. **TS7 native 与 typescript-eslint 不兼容**：`typescript@7` 没有 JS API，lint 只能用 Biome，不要再试 eslint 路线。Biome 解析 CSS 要开 `css.parser.tailwindDirectives`（`biome.json` 已开，`styles.css` 用了 `@apply`）。
9. **Tailwind 扫描源漂移是静默的**：整批工具类缺失时构建照样成功、页面裸奔。`build-apk.mjs` 以仓库根为 cwd 并显式传 `--config mobile/vite.config.ts`，再跑 `check-tailwind-classes.mjs` 哨兵；新增扫描源时在脚本里补哨兵类。
10. **hooks 必须在所有 early return 之前**：条件渲染后少声明 hook，React 报 “Rendered fewer hooks than expected”，Android WebView 表现为整页黑屏卡死且无任何报错。
11. **SSE 断连与 invoke 超时**：WebView 里 `EventSource` 到 CLOSED 不会自动重连——invoke 照常成功但事件永远收不到，表象是「一直生成中」；无超时的 fetch 在响应丢失时永久悬挂。`bridge.ts` 已有退避重连 + 30s 超时，不要绕开 bridge 直接 fetch。
12. **新增顶层目录要同步 tsconfig include**：根 tsconfig 只含 `src`，`mobile/tsconfig.json` 只含 `src`、`vite.config.ts`、`../src/shared`。不在 include 里的文件完全脱离 typecheck，坏 import 假绿。
13. **Windows / Git Bash**：`taskkill /F /T` 从 Git Bash 调用要加 `MSYS_NO_PATHCONV=1`（参数会被误转成路径）。
    **`process.exit()` 不要紧跟在几次 `fetch` 之后**：会以 libuv 断言崩溃收场（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`，退出码 3221226505）。实测连续 6 次请求后 10ms 内 exit 必崩、20ms 约三成、50ms 以上不崩；只发一两次不崩。`stdio: 'inherit'` 挡不住，与有没有子进程无关，`setImmediate` 让一轮也不够。
    冒烟脚本原先靠 kill 后 sleep 300–800ms 再 exit 躲过，是个竞态——现在收尾后一律设 `process.exitCode` 自然退出。冒烟与部署脚本的子进程仍用 `stdio: 'inherit'`（输出直接透传）。
14. **新增或改名 agent 工具**：同步 `mobile/src/pages/write/labels.ts` 的 `TOOL_LABEL` 中文名（缺失只显示裸英文名，不报错）。
15. **版本号 tag 边界**：`version.mjs` 用 `git log <tag>..HEAD` 算增量，最新 tag 不在当前分支祖先链（从 main = v1 拉的 worktree、浅克隆）时会纳入无关提交而过度升版；tag 已存在时严格抛错，不会静默写坏 package.json。
16. **开线坑**：`worktree_create` 默认从 main（v1）拉新 worktree，不是 feat/v2-rebuild——开线后先 `git switch -c <branch> && git reset --hard feat/v2-rebuild`，再 `npm ci`。
17. **Capacitor `PluginCall.getLong` / `getInt` 只认精确类型**：JS 传来的整数经 JSON 到原生是 `Integer`，`getLong` 只认 `Long`，类型不符一律返回默认值——APK 自更新的 versionCode 曾因此永远读成 0，所有版本都落到固定文件名、反复安装旧包（`-25 无法降级安装`）。原生取数值参数一律 `call.getData().opt(name)` 后按 `Number` 自己转；APK 交给系统安装器前先用 `getPackageArchiveInfo` 核对包内真实 versionCode。
18. **DeepSeek 思考模式带工具的续轮必须回传 `reasoning_content`**：官方文档写明带 `tools` 的请求要把之前各轮 assistant 的思考链原样传回，否则 400。但线上实测：只要工具调用 id 是模型真实签发的，不回传也是 200，伪造 id 才 400——所以冒烟桩（自己编 `call_x` id、不校验消息体）测不出这个回归。`ChatMessage.reasoning` → `llmOpenai.ts` 转 `reasoning_content` → `loop.ts` 回灌 assistant 历史时挂上 `res.thinking`，改这条链只能靠真实 DeepSeek 验证；思考关闭时不带。

## 入口

- `docs/v2/DECISIONS.md`：需求决策单一事实源（新需求先查这里，冲突以它为准）
- `docs/v2/HANDOFF.md`：任务交接板
- `docs/v2/HISTORY.md`：v2 演进史 + 旧 AGENTS.md 迁移对照表
- `docs/v1/LEGACY.md`：v1 归档
