# v2 演进史

> 过程记录，回答「怎么走到今天、当时为什么这么做」。**现状以 `AGENTS.md` 为准**——本文标注「已废」的能力不要照着复活。
> 需求层面的决策见 `docs/v2/DECISIONS.md`（单一事实源）；v1（Electron 版）的架构与踩坑见 `docs/v1/LEGACY.md`。
> 提交号取自分支 feat/v2-rebuild 的 `git log`。M1–M7 的提交都落在 2026-11-05 同一天，是压缩后的历史。

## 0. 起点：从 v1 到 v2

- v1 是 Electron 桌面应用（2026-09 ~ 2026-10），代码归档在 tag `archive/v1`。
- 2026-11-05 `e1221ea` M0：删产品层、保底座（server 骨架 / llmOpenai / APK 构建链 / tray.png）。
- 同日 `d1c6d28` 落需求决策记录：六轮 grillme 盘问共识 52 项 + REQUIREMENTS.md 草案融合 24 项，冲突以盘问共识为准。草案 `REQUIREMENTS.md` 本身**没有入库**（旧 AGENTS.md 曾把它写成单一事实源，属悬空引用）。
- 核心决策：无 Electron（独立 Node 托盘进程）/ 手机唯一入口 / 统一 OpenAI 协议 / 分叉树数据模型（不分卷、不合并、无状态机、无真删除）/ 写完停手 / 无通知 / 无尺度字段 / 版本号从 v3.0.0 起、旧数据不迁移。
- 最初定下的「无导出」「走向卡片确认」后来都被用户需求推翻，见 §9、§10。

## 1. M1 纯 Node 底座 + 无鉴权直连（`c9a7df4`、`730a6d6`）

- server 从 Electron 主进程里解耦成纯 Node 常驻服务，配托盘（状态 / 开机自启 / 重启 / 退出）。
- 数据目录定在 `%APPDATA%/novel-maker-v2`，与 v1 的 Electron userData 隔离：v1 settings 含 safeStorage 密文和旧 schema，混读必炸。
- 技术底色在此定型：tsc 直出 ESM 无 bundler（`module=NodeNext`，相对 import 带 `.js`）、内置 `node:sqlite`、invoke 走 `POST /api/invoke/:channel` 且元组整体传 handler。
- `730a6d6`（breaking）砍掉配对层：原方案是扫码 + 密码 + token（serverSessions.ts、/api/mobile/auth、/api/qr.png、登录限速、托盘二维码与改密菜单），用户改为「无鉴权直连」——Tailscale 网络本身就是信任边界，手机手输一次地址即用。DECISIONS 的 A2/A10/M1 同步修订。
- systray 1.0.5 的 CJS 解包坑在这时踩到并写死在 `tray.ts`（见 AGENTS.md 踩坑记录）。

## 2. M2 分叉树数据层 + 导演内核（`b32c4c3`）

- 数据层：`db.ts` 当时 11 张表（books / lines / chapters / chapter_versions / cards / characters / foreshadows / memories / messages / jobs），`store.ts` 的 `effectiveChapters` 与 `forkLine` 是分叉树的核心。
- 当时的写作循环是**固定流水线**（DECISIONS W1–W3）：proposal 走向卡片（4 张类型各异）→ 章级大纲 → 场景分镜（可跳过）→ 流式正文 → 自检（lint 硬闸）→ 纪要卡落库（stateChanges 改人物活状态 / cardOps 落卡 / foreshadowOps 埋设-计划-回收）。自检不过自动修一次再问作者。**已被 M6 的自由 agent 取代。**
- `director/` 成型：`callJson`（结构化输出 + 网络重试 + 记账）、`steps`（各步 prompt）、`context`（预算 24000 字：引用 ≤35% / 历史 ≤25% / 检索 ≤15%，比例沿用至今）、`onboard`（四阶段开书引导：设定采访 → 世界观草案 → 人物草案 → 书名简介）、`prompts`（导演人格 + 红线 + 文风）。
- 契约当时新增 27 个通道；事件只有 `job:update` / `job:delta`，经 `broadcast.ts` 的 `setGlobalSink` 在 server 启动时接上。
- 踩过的坑：zod4 的 `z.record(enumKey, V)` 要求枚举键全部出现（partial 语义要用 `z.partialRecord`）；自检一次通过的路径没把 draft 显式传给 finalize，`payload.draftText` 没落库（已修，finalize 链路随 M6 拆除）。
- 冒烟：`scripts/smoke-m2.mjs` + 可复用的队列式 LLM 桩 `scripts/smoke-llm-stub.mjs`。handlers 开始按域拆分并用 `Pick<HandlerTable, …>` 标注（如 `book:update` 走 `store.updateBook`）。

## 3. M3 手机端全部页面（`1f9956b`）

- `mobile/` 作为独立 vite 应用成型：Connect / Shelf / Onboard / BookWorkspace（写作·阅读·设定·线）/ Write / Read（目录 / 正文 / 字号 / 主题 / 进度）/ Cards（卡·人物·伏笔 + 钉选）/ Lines（分叉 / 切线 / 删除）/ Settings（连接 / 模型 / 用量 / APP 更新）；`buildApi` 跑在 fetch + SSE 上。
- Playwright 端到端联调全绿，联调路径：Connect → 开新书 → 4 轮引导 → 进书 → 走向卡 → 大纲 → 跳过分镜 → 流式 → 一次过自检 → 纪要卡 → 目录 2 章 → 正文 / 字号 / 主题 → 设定页 → 分叉复仇线 → Settings 用量。
- 联调修掉的两个真 bug：① `installBridge` 只在启动时调，首启未连接时连接后 `window.api` 永远缺失（修：App.tsx 在 conn 就绪后补装，幂等）；② `useActiveJob` 只返回非终态 job，done 被过滤导致纪要卡永不显示（修：`useJobFlow` 返回 `{active, lastDone}`）。
- 联调设施 `scripts/smoke-m3-stub.mjs`（端口 3923）：`SKIP_ONBOARD=1` 跳过前 4 个 onboard 响应用于已开书续写；队列耗尽返回 `{}`，反而暴露了 autoFix / genRecap 的容错路径。
- 遗留：onboard title 阶段的确认正则不认书名文本，真实模型给书名按钮会卡（M4 修）。

## 4. M4 打磨（`a7bcc6c`）

- JobKind 扩出 revise / review / audit / diagnose，pump 按 kind 分发。
- `job:startRevise [chapterId, instruction, segment?]`：流式改章 → lint 只展示不入闸 → `replaceChapterContent`，旧版自动进 `chapter_versions`（**章内多版本回看已在 §9 删除**）。
- `job:startReview / startAudit / startDiagnose` 产出 `AgentReport{verdict, findings, suggestions, score}`；审计门槛（章数 < 2 快速失败不烧模型）与「每满 8 章自动排后台审计」从这时起沿用。
- 流式 delta 每 3s 落 `payload.draftText`，断网 / 杀 APP 后可恢复显示；纪要卡新增 quickActions（agent 每章动态建议的快捷钮，随 recap 顺带产出，零额外调用）。
- 手机端：Write.tsx 按 kind 分流、IdleView 体检台、Read 页的选段修改与历史版本回看、`components/{QuickActionsBar, ReportCard}`。
- onboard 确认正则改为兼容书名文本。
- 冒烟 `smoke-m4.mjs`；stub 尾部加了 revise / review / audit / diagnose 四种响应。
- 当时记下的四个小坑：invoke 响应是 `{result}` 包装（客户端取 `body.result`）；`settings:save` 切 provider 必须带顶层 `provider` 字段；`confirmOutline` 的 edits 不可传 null（省略或传对象，通道已删）；spawn 的管道 stdio 在 Windows `process.exit` 时触发 libuv 断言崩溃（改用 inherit）。

## 5. M5 智能体页 + APK 构建链（`404943b`、`3cece5c`）

- 用户验收期提出「对话流吞掉写作流」：写作页改成聊天时间轴，`messages` 表成为单一事实源——用户动作是右气泡、导演白话是左气泡、任务节点是节点卡（前端用 job list 建 jobId → job 映射取 payload 渲染走向卡 / 大纲 / 分镜 / 入书卡 / 报告 / 失败 / 取消）。
- `jobs.ts` 在状态机各转换点落节点消息；新增 `chat` 任务（`job:startChat [bookId, text]`，50–300 字自由交流、不执行写作动作），历史取最近 12 条 chat 消息。踩坑：用户的发言也必须是 `kind=chat`，曾因默认成 action 导致导演看不到用户说过的话。
- 可交互判定靠 `WAIT_STEP_FOR`（waiting 挂在「下一步」上）；底部输入栏有写下一章 / 审读上一章 / 全书审计 / 改这章等快捷钮。**两者都已在 M7 删除。** genChat 走 `callRaw`（覆盖 messages / responseFormat）；流式条恢复时从 `payload.draftText` 续显（streamingSaver 每 3s 落盘）。
- 冒烟 `smoke-m5.mjs`，stub 支持 `CHAT_FIRST=1`。
- `3cece5c` 把 APK 构建链接回并打通更新源（DECISIONS 草案里的 F-01「sync-bundle.mjs 缺失致 APK 链断」在此修复）。

## 6. 范文库（`e28b7ff`）

- txt 导入全文入库、agent 节选翻阅工具（`read_sample`）、书级绑定后把写作纪律注入提示。后续追加：多本绑定、结构化切节、章标题识别、APP 内阅读层（目录 / 正文 / 全文检索）。

## 7. M6 全面 agent 化（`b1b3a48`）

- 用户决策：写作循环改成自由 agent + 全 CRUD 权限 + 透明工具卡，只留走向确认。废除大纲 / 分镜确认与自检等待：`runProposal`（走向卡）→ `chooseDirection` → agent 自主段（查资料 → `write_chapter_draft` → 自检（major 自动修一轮）→ `commit_chapter` → 沉淀工具 → `finish`）。契约删掉 `job:confirmOutline` / `confirmScenes` / `acceptFlaws`。
- `agent/tools.ts` 当时 20 个 CRUD 工具（读 9 / 写 7 / 删 4，删除类先自动快照）；`agent/loop.ts` 的 `runAgentLoop`（maxTurns 30）拦截 `write_chapter_draft` / `commit_chapter` / `revise_chapter` / `finish` 内联实现；工具卡 = messages 行 `meta={kind:'tool', jobId, tool, summary, ok}`，给作者看的内容截 2000 字，给 LLM 的全文上限 30000 字。
- 正负词机制：`books.positive_words / negative_words` 两列，负向词命中即 lint major，正向词只提示。
- 细节：`patch_character_state` 支持 characterId 或 name 兜底（模型常给名字）；前端 `WAIT_STEP_FOR` 只剩 cards↔outline，ToolCard 折叠卡带 `TOOL_LABEL` 中文名、`ok=false` 标红，StreamingBar 在 write 的 `agent` 步 / revise / chat 时显示。
- `genRecap / applyRecap` 旧链拆除，改由 agent 实时沉淀。
- 冒烟：`smoke-m6.mjs` 18 断言；m2 / m4 / m5 迁到 `AGENT_MODE` 队列。从这时起「stub 队列顺序敏感」成为冒烟的长期注意事项。
- 当时踩的坑：`chooseDirection` 返回的是跑完整轮 agent 之后的终态 Job；`loop.ts` 的 `let book: Book` 必须显式标注类型（闭包内窄化丢失）；桩一次性给完整的 tool_calls chunk（llmOpenai 按 index 累积，兼容）。

## 8. M7 智能体页重构（`bb9d194`）

- 统一原则（沿用至今）：一切生成内容不进聊天流式——agent 一律调工具产出，聊天流只有对话气泡、工具卡和成品卡；过程进度走聚合条；入书卡是正文唯一正式出场。
- 事件扩成 `job:activity`（工具卡实时推）/ `job:progress`（正文 / 改章字数进度）/ `job:delta`（改三参，带累计长度 total）；前端失配时 `job:get` 拉 `payload.answer`，服务端是唯一真相源，根治串流重复 / 错乱。
- 全对话化：输入栏删掉全部快捷钮，改为三个意图工具 `propose_chapter{directionHint?}` / `request_review{chapterId?}` / `request_audit`，由 jobs 层注入 actions 转成排队任务或文本回报；`startWrite(bookId, hint?)` 的倾向当时贯穿到 genDirections（走向卡废除后直通 agent）。
- streamingSaver 拆成 chatSaver（白话 + `payload.answer`）与 progressSaver（正文 + `payload.draftText`）；jobs.ts 里 progressSaver / emitJobProgress 的死 import 同轮清理（进度事件改由 loop 侧接管）。
- 前端：StatusHead 一行胶囊、AgentTicker 聚合条，正文流式渲染整体移除。
- 这一轮没加新断言（事件层由真机验收覆盖）。

## 9. 交付期修正（2026-11-06 ~ 11-08）

- `8381486` 思考链流式 + 正文实时渲染；`45231eb` opencode 式交错时间轴（思考 / 工具 / 对话按真实顺序上墙）。
- `2ed1146` 写章短正文根因修复：思考吃输出预算 → 默认禁思考，长章分段续写。
- `2ab161b`（breaking）**废除走向卡**：走向卡全链拆除（runProposal / chooseDirection / genDirections 与对应契约通道删除），`startWrite` 直通 agent 全链，倾向经聊天或 `directionHint` 传入；改章 plan 化（`genRevisePlan` → `RevisePlan{rewrite?, edits[{find, replace}]}`，`applyRevisePlan` 纯函数应用，默认局部替换，推倒才整章重写，noHit 报错不落库），`replaceChapterContent` 直接覆盖、章内版本回看删除；新增**计划模式**（书级 `planMode`：先出计划书等作者过目，等待期可聊）。用户决策：聊天驱动，agent 自主定走向。
- `e12a67b` 版本号双钟不一致与更新误判；`9d311a2` AI 页拆分单文件；`6902a06` AI 页实时刷新重构 + 上下文压缩 + 欠费提示；`421a00d` `spawn_subagent` 改为只读调查员，省父级 token 与上下文。
- `965f258` 设定 / 人设卡结构化 JSON + 表格渲染；`b78ce4e` 乐观消息；`d094b5d`、`a9062c1` 等范文阅读层系列。
- `1ef7293` v2 全量功能真机交付完毕，版本转正 3.0.0。

## 10. M8 打磨（2026-11-09 ~ 11-16）

- `2d44902` **save_* 改部分更新语义**（用户实锤：AI `save_character` 只传 id 没传 name，把人物名清空）；同时删掉底部细状态行 LiveRow（用户反馈表现不好），取消入口并入 StatusHead（运行中变橙色胶囊，chat 直取消、写作走确认弹层），贴底跟随改由 ResizeObserver 承担；`smoke-partial-update.mjs` 覆盖三个 save 的「不传标题字段 → 保留」。
- `99934b5` 工具集整理分类并补读能力缺口；`d95e097`、`2b6d012` 设定卡按类别筛选、类别自由化（自定义类别 + 整类迁移 + 动态筛选）。
- `a558316` 人设卡钉选 UI 重设计：钉选改为行尾图钉并与设定卡共享组件，钉选置顶分组（「钉选（每次写作必带）/ 其余」）；tags 改从人设 JSON 的 tags / 标签 / 身份 / 特质键读取（数组、逗号串兼容）。
- `f011c1a` 书架重设计 + **删除书 = 归档**（用户需求「重新设计首页 + 删除书 = 归档」）：最近的书大卡置顶（按 id hash 取色渐变、续写提示、相对时间），其余是带书脊色条与章数的列表卡和 ⋯ 菜单（打开 / 归档）。
  归档是 `book.update {archived:true}`，内容全保留、不是真删；恢复入口在设置页「已归档的书」和书架尾部的「已归档 N 本」入口行。`book:list` 保持全量返回（设置页要归档书），书架由前端过滤；
  `StatusCard` 加了 `bookId`（此前按书名匹配不可靠），`useShelfStatus` 批量取 statusCard（staleTime 30s）；`smoke-archive.mjs` 7 断言。
- `b3bff93` 已归档的书可彻底删除（两步确认，走 `book:delete` 带 confirm，级联删 + 删前快照）；`5d2f72e` 归档入口行并修复归档静默失败；`3cce0df` 大卡片跟随上次打开的书；`cb349ae` 归档入口挪到顶部。
- `95f2ca9` 草稿书机制：没产生对话的新书不保存，另加 APP 更新后台状态恢复。
- `0c29c9f`（breaking）**人设卡三件套**（grillme 共识）：`characters.card` 列改名 `data` 并启用 `tags` 列，平铺无嵌套、冷热分离（data = 你是谁 / state = 你现在怎样）；工具拆成 `save_character`（建档 / 元信息）/ `update_character_tags`（增量 add / delete）/ `update_character_data`（浅合并）/ `patch_character_state`。连带：`list_characters` 支持标签检索（`ca7001e`），人设胶囊只显示 tags 列（`915cf74`），tags 初值钉死短词口径（`4a5351a`）。踩坑：`forkLine` 的深拷贝列清单写死列名，改表列必须同步（m2 冒烟实锤）；只改 store 层的 optional 不够，`contract.ts` 的 InputSchema 不同步的话 HTTP 链路照样拒（`smoke-http-patch.mjs` 覆盖）。
- `1ef70b9` APK 自更新下载文件按 versionCode 隔离（用户实锤：检测到新版却反复装 4.0.0）。
- `0c13d62` 设定卡 / 人设卡删除入口 + HTTP 删除前自动快照。
- `f1c277e` 光说不练拦截；`772451f` 思考吃满输出预算不再静默退出；`501b431` 思考轮输出上限一步到位 16K / 32K，省掉必然浪费的截断重试。
- `1374215` 引入任务交接板 `docs/v2/HANDOFF.md`，防会话中断丢状态。
- `4494bc2` **书架全书导出**：`GET /api/export/:bookId`（fflate zipSync，当前激活线每章一个 `0001-标题.txt`，空书 400 / 不存在 404），`ExportPlugin.java` 走 SAF 系统保存器选位置，前端 `exportPlugin.ts` 分块 base64 写入，用户取消静默处理。v2 曾定「无导出」，被用户需求推翻。
- `645815b` 底部导航栏优化；`69f2f7c` 阅读页体验优化（切章滚顶 / 夜间模式 / 缩进 / 进度 / 容错）。

## 11. 自主优化长跑（2026-11-25，三个开发线）

用户授权「自己提需求自己改，每个需求包一条开发线」。三份后台审查（后端健壮性 / 移动端体验 / 数据安全与运维）去重后定出需求包 A–E。

- **线 A `chore/hygiene`**（合并 `65df5f2`，APK v4.5.0）：删死代码与模板测试；Biome 纳管 `mobile/src` 与 `scripts`；删无人调用的裸 LLM 代理通道；`npm test` 改为冒烟总入口；**构建指纹进 health**（`862051e`）——此前 health 的 version 是部署时的 package.json 版本，而出包后才 bump，「server 版本落后 package.json」恒成立，旧判据不可靠，且「改主进程忘 deploy」实锤过一次；README、.gitignore、engines 补齐。
- **线 B `fix/job-lifecycle`**（合并 `09db98f`，无手机端改动故未出 APK）：LLM 层重试判定改读结构化状态码（429 / 5xx 此前不重试）并识别流中断与挂起；`applyRevisePlan` 按字面量替换；**任务生命周期重构**——启动接口入队即返回（此前等整轮，手机 30s 超时显示「发送失败」）、`running: Map<jobId, AbortController>` 取代单变量、取消与看门狗真正中止在跑的请求、终态写入带 `WHERE state='running'`、队列 FIFO、重启后 queued 续跑；`smoke-jobs.mjs` 28 断言；invoke 异常留痕。
- **线 C `feat/data-safety`**（合并 `b8806c7`，APK v4.6.0）：**备份体系**（`e2306cf`）——每日一份 gzip、保留策略、删除前快照限量、结构升级前自动快照、`backup:list / create / restore`、设置页「备份与恢复」；`settings.json` 原子写，损坏时改名保全（`33971d9`）；分叉点保护——起点章不可删、`lines.fork_order`（`f3d6e26`）；开书引导确认草案先问后存、重复确认幂等、`onboard:answer` 带 `expectStage`（`95835de`）；`save_character` 改已有人物时不再覆盖活状态（`7c336c9`）；范文摘要链路不再读全文（`9186eba`）。
- **线 D `feat/mobile-polish`**：开发中（失败卡重试钮、统一错误态、BottomSheet 返回键、delta 补拉请求风暴等），进度看 `HANDOFF.md`。
- **线 E `docs/agents-v2`**：即本次 AGENTS.md 重写。

## 12. 待核实 / 未落地

- **语义嵌入检索**：DECISIONS G10 定「一期就带本地 bge-small-zh」，但 v2 依赖里没有 transformers.js，`search_project` 是 SQL `LIKE` 关键词检索。属于「决策已定、实现未落地」。
- **tool_calls 配对防护**：v1 在 Anthropic 协议下踩过「无 result 的 tool_use 回灌必 400」，v2 的 `loop.ts` 在 OpenAI 协议下是否有等价防护（跳过被中断的 tool_calls）未核实。
- **`settings:save` 切 provider**：M4 记过「切 provider 必须带顶层 `provider` 字段」，按 `config.ts` 的结构看应仍成立，未逐行验证。
- **`chapter_versions` 表**：功能（章内多版本回看）已随 `2ab161b` 删除，建表语句仍留在 `db.ts`，是否清理待定。
- **`rewrite` JobKind**：类型里有，`jobs.ts` 未见对应 runner，疑似遗留。
- **裸 LLM 错误文案**：LLM 错误对用户仍直接显示底层信息（线 B 遗留）。

## 13. 迁移对照表（旧 `AGENTS.md` → 去向）

旧版 257 行，按原文件行号列出，保证没有信息被静默丢弃。「保留」= 已按 v2 现状改写进新 AGENTS.md；「历史」= 本文对应章节；「归档」= `docs/v1/LEGACY.md`；「已废弃」= 对应代码或决策在 v2 已不存在，仅存于 git 历史。

### 章节 / 段落

| 旧行号 | 内容 | 去向 |
|---|---|---|
| 3–9 | v2 横幅：archive/v1、REQUIREMENTS.md、核心决策 | 核心决策 → 保留（速览）+ 历史 §0；REQUIREMENTS.md 引用作废（未入库，事实源是 DECISIONS.md） |
| 11–22 | M1：命令、数据目录、invoke、无鉴权、NodeNext、systray、handlers 导入 | 保留（速览、电脑端、踩坑 1）；过程 → 历史 §1 |
| 24–40 | M2：11 表、effectiveChapters、forkLine、导演循环五步、director 模块、27 通道、zod4、finalize 坑、冒烟 | 数据层与 zod4 → 保留；五步流水线、预算数字、finalize 坑、27 通道 → 历史 §2 |
| 42–54 | M3：页面清单、两个 UI bug、联调设施与路径、onboard 正则待改 | 历史 §3（bug 已修、待改项 M4 已完成）；stub 开关 → 保留（冒烟） |
| 56–70 | M4：JobKind、改章版本、审计门槛、streamingSaver、quickActions、前端分流、冒烟、四个小坑 | 审计门槛 → 保留；其余 → 历史 §4；`{result}` 包装 → 保留（invoke 形态）；spawn stdio → 保留（踩坑）；`confirmOutline` → 已废弃 |
| 72–85 | M5：聊天时间轴、节点消息、chat 任务、可交互判定、输入栏、冒烟 | 时间轴与消息 kind → 保留；WAIT_STEP_FOR、快捷钮 → 历史 §5；「见上文 M5 段落」是悬空引用 → 历史 §5 |
| 87–106 | M6：agent 自主段、工具集、loop、正负词、前端、冒烟队列、三个坑 | agent 链路、正负词、stub 队列 → 保留；走向确认与 chooseDirection 坑 → 历史 §7 |
| 108–121 | M7：统一原则、事件、saver、全对话化、前端、冒烟 | 统一原则与事件 → 保留；其余 → 历史 §8 |
| 123–133 | M8：save patch、删 LiveRow | save patch → 保留（踩坑）；UI 调整 → 历史 §10 |
| 134–139 | 人设卡 tags 展示、zod 契约同步坑 | zod 契约同步 → 保留（踩坑）；tags 展示 → 历史 §10 |
| 140–143 | APK 自更新版本隔离 | 保留（踩坑）+ 历史 §10 |
| 144–150 | 书架全书导出 | 端点与入口 → 保留；插件实现细节 → 历史 §10 |
| 151–155 | thinking 截断补救 | 保留（踩坑）+ 历史 §10 |
| 156–161 | 人设卡三件套、forkLine 列清单 | forkLine → 保留（踩坑）；三件套 → 历史 §10 |
| 162–169 | 书架重设计 + 归档 | 归档语义 → 保留（数据层）；UI 细节 → 历史 §10 |
| 170–173 | 部署坑 | 保留（部署，判据已换成构建指纹） |
| 175–180 | 任务交接纪律 | 保留（原样，置于顶部） |
| 182–187 | 常用命令（v1） | Electron 窗口、三套 tsconfig、out/、`npm run dist` → 归档；Biome 门禁 → 保留（按 package.json 重写） |
| 189–192 | 版本号 | 保留（补充 v4.5 起的出包两阶段） |
| 194–196 | 项目级 skill（`.opencode/skill/reload`、`reviewer`） | 归档。`.opencode/` 被 .gitignore 且当前检出中不存在，描述的 3910/5173 登录流程属 v1 |
| 197–207 | v1 架构 | 整节 → 归档；仍成立的三条（AI 收敛原则、契约层做法、更新型写入语义）→ 保留 |
| 209–249 | 踩坑记录 1–36 | 逐条见下表 |
| 251–257 | 约定（5 条） | 逐条见下表 |

### 踩坑记录 1–36

| # | 主题 | 去向 |
|---|---|---|
| 1 | electron-vite 与 vite 版本钉死 | 已废弃（v2 直接用 vite 7，无 electron-vite）→ 归档 |
| 2 | Electron 二进制下载 | 已废弃 → 归档 |
| 3 | preload 产物路径 | 已废弃 → 归档 |
| 4 | Git Bash 调 taskkill 要 `MSYS_NO_PATHCONV=1` | 保留（环境级，踩坑） |
| 5 | 原生模块一律不用，SQLite 用内置 node:sqlite | 保留（电脑端） |
| 6 | 杀 electron 测试进程 | 已废弃 → 归档 |
| 7 | remote-debugging-port 传参丢失 | 已废弃 → 归档 |
| 8 | CDP 无 GUI 联调 | 已废弃 → 归档（v2 用 API 级冒烟） |
| 9 | Anthropic tool_use / tool_result 配对约束 | 协议已换 → 归档；OpenAI 下的等价防护 → 历史 §12 待核实 |
| 10 | react-markdown `defaultUrlTransform` | 已废弃（v2 无 wikilink scheme，`mobile/src` 未用 `urlTransform`）→ 归档 |
| 11 | 编辑器即时渲染方案放弃 | 已废弃（v2 正文只读无编辑器）→ 归档 |
| 12 | electron-vite dev 不热重载 shared / preload | 已废弃 → 归档 |
| 13 | CDP evaluate 模拟 UI | 已废弃 → 归档 |
| 14 | GLM thinking 吃光输出预算 | 协议已换 → 归档；同类问题在 v2 的形态 → 保留（踩坑「思考吃满输出预算」） |
| 15 | 内置 skill 的 version 覆盖开关 | 已废弃（v2 无内置 skill 体系）→ 归档 |
| 16 | 内嵌服务器 / 手机浏览器版（web-bridge、双 sink、密码 cookie、局域网 IP 评分） | 已废弃 → 归档；「浏览器端无响应先查 SSE」→ 保留（踩坑） |
| 17 | 多 provider 只走 Anthropic 协议 | 已废弃（v2 统一 OpenAI 协议）→ 归档 |
| 18 | transformers.js 懒加载 | 已废弃 → 归档；嵌入检索未落地 → 历史 §12 |
| 19 | skills seed 依赖启动序列 | 已废弃 → 归档 |
| 20 | typescript-eslint 与 TS7 native 不兼容 | 保留（踩坑） |
| 21 | Biome CSS 解析开 tailwindDirectives；a11y codemod；biome-ignore 位置 | tailwindDirectives → 保留；其余两条 → 归档（原文保留，v2 未复验） |
| 22 | `exporter:run` 改名；`ArgsOf<C>` 不能当 rest 参数 | 改名 → 已废弃 → 归档；泛型元组 → 保留（并入 invoke 形态） |
| 23 | handler 元组不能 spread | 保留（invoke 形态） |
| 24 | 手机 APP 架构（Capacitor 壳、自更新、registerPlugin 时序、token 鉴权、8899 下载） | 壳 + 自更新 + registerPlugin + 连接地址 → 保留；token 鉴权已随无鉴权决策废弃；8899 手动下载 → 归档（v2 server.ts 未见该端点） |
| 25 | 浏览器端「无响应」先查 SSE 生命周期 | 保留（踩坑，改写为 WebView 语境） |
| 26 | 新增顶层目录必须同步 tsconfig include | 保留（踩坑，按 v2 的两套 tsconfig 改写） |
| 27 | 起 dev 实例的命令不能长挂 | 归档（针对 Electron 测试实例；通用做法见全局规则：长命令用 background） |
| 28 | Tailwind v4 自动源检测不覆盖 `src/wizard` | `src/wizard` → 已废弃 → 归档；哨兵校验防线 → 保留（踩坑） |
| 29 | `@source` 路径相对 CSS 文件解析 | 归档（v2 无 `@source`，唯一扫描源是 vite root）；同类问题改由哨兵覆盖 → 保留 |
| 30 | hooks 必须在 early return 之前 | 保留（踩坑） |
| 31 | 章节状态链（chapters.status / outlines.status） | 已废弃（v2 无 outlines 表、无状态机）→ 归档 |
| 32 | invoke 必须带超时 | 保留（并入 SSE 踩坑） |
| 33 | 版本号自动推进的边界 | 保留（精简；①② 已被出包两阶段解决，③④ 仍在） |
| 34 | CDP 冒烟 import 动态发现 URL | 已废弃 → 归档 |
| 35 | 测试实例与测试任务的前置检查 | Electron 部分已废弃 → 归档（「测 agent 前确认 provider 余额」是通用提醒） |
| 36 | agent 工具集三处映射 + CDP 事件等待 | 映射在 v2 只剩 `TOOL_LABEL` 一处 → 保留（踩坑）；CDP 部分 → 归档 |

### 约定（旧行 252–257）

| 旧约定 | 去向 |
|---|---|
| API Key 仅存主进程，渲染进程只拿掩码；统一走鉴权入口 | 保留（改写：Key 存 `settings.json`，`settings:save` 只写不读）；跨 provider 路由细节 → 归档 |
| 新增能力写进 `sharedHandlers`，通道签名先改 contract.ts | 保留（「新增契约通道」） |
| 每次请求必须 appendUsage 记账 | 保留（LLM） |
| 更新型写入语义：未传保留、显式空串才清空 | 保留（并入 save_* 部分更新） |
| 世界观 `[[目标\|关系]]` wikilink 与标题传播 | 已废弃（v2 无图谱 / wikilink）→ 归档 |
| 测试收尾帮用户重启 Electron dev 实例 | 已废弃 → 归档 |
