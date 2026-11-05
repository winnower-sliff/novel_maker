# novel_maker 项目须知

> **⚠️ v2 完全重构进行中（2026-11 起，分支 feat/v2-rebuild）**
> 本文件主体仍是 v1 知识，仅「踩坑记录」与底座相关部分在 v2 期间仍有参考价值。
> v1 完整代码见 git tag `archive/v1`。
> v2 需求单一事实源：`docs/v2/REQUIREMENTS.md` + 盘问共识（52 项 + 草案融合 24 项，见 v2 需求记录）。
> v2 核心决策：无 Electron 桌面端（独立 Node 托盘进程）/ 手机唯一入口 / 统一 OpenAI 协议 /
> 分叉树数据模型（不分卷、无状态机、无真删除）/ 导演循环（现状卡→走向卡片→两级大纲→流式正文→纪要卡）/
> 无通知、无导出、无尺度字段、写完停手。M1 起本文件将被全面重写。
>
> **M1 已完成（server 解耦+托盘）**：纯 Node 底座 = src/main/{index,server,serverState,eventSink,
> llm,llmOpenai,usage,config,paths,runs,connect,autostart,tray,handlers/}。要点：
> - 命令：`npm run dev`（tsx watch）/ `build`（tsc→dist）/ `deploy`（build+杀旧+detached 拉新+健康探测）/ `typecheck` / `lint`
> - 数据目录：`%APPDATA%/novel-maker-v2`（与 v1 userData 隔离！v1 settings 含 safeStorage 密文，混读必炸）；`NM_DATA_DIR` 覆盖
> - invoke 约定：POST /api/invoke/:channel，body=`{"args":[元组]}`（元组整体传 handler，不 spread——坑 23 仍适用）
> - **无鉴权（2026-11 用户决策）**：Tailscale 网络即信任边界——无密码/token/二维码/登录限速；
>   手机端手输一次地址（默认值预置）即用；serverSessions.ts/first-run 密码/qr 端点/托盘二维码与改密菜单已全部拆除
> - NodeNext 要求相对 import 带 `.js` 扩展名（tsc 直出 ESM，无 bundler）
> - systray 1.0.5 坑：CJS 老包（TS2.8 编译 exports.default 间接赋值，cjs-module-lexer 不识别），
>   ESM default import 拿到的是 module.exports 对象，构造函数在 `.default` 上；TS7/NodeNext 也无法把 default 当类用
>   ——tray.ts 手写窄接口 + 运行时解包，勿改回 `import SysTray from 'systray'` 直接 new
> - handlers 目录 import 必须写 `./handlers/index.js`（NodeNext 不支持目录导入）
>
> **M2 已完成（分叉树数据层+导演内核，API 级第 1 回合冒烟 26 断言全绿）**：
> - 数据层：`src/main/db.ts`（node:sqlite，11 表：books/lines/chapters/chapter_versions/cards/characters/
>   foreshadows/memories/messages/jobs）+ `src/main/store.ts`（CRUD；**effectiveChapters**=分叉树核心读操作
>   ——祖先线 fork 点前章节+本线章节按序拼接；**forkLine**=事务深拷贝 cards/characters/foreshadows+fork 点前
>   memories 到新线，设定各线独立演化；chapter_versions 支持章内多版本回看）
> - 导演循环：`src/main/jobs.ts`（流水线状态机+全局串行队列+看门狗 10min+重启恢复）五步 =
>   proposal 走向卡片(4 张类型各异)→章级大纲→场景分镜(可跳过)→流式正文→自检(lint 硬闸)→纪要卡落库
>   （stateChanges patch 人物活状态/cardOps 落卡/foreshadowOps plant-plan-resolve）；自检不过自动修一次再问
> - LLM 调用：`src/main/director/`（callJson 结构化+网络重试+记账 / steps 各步 prompt / context 上下文装配
>   预算 24000 钉选 35% 历史 25% 检索 15% / onboard 四阶段开书引导 / prompts 导演人格+红线+文风）
> - 契约：contract.ts 新增 27 通道（book/line/chapter/card/character/foreshadow/message/job/onboard）+
>   事件 job:update/job:delta（broadcast.ts setGlobalSink，server 启动时接 webSink）
> - **zod4 坑**：`z.record(enumKey, V)` 语义=枚举所有键必需，partial 语义必须用 `z.partialRecord`
>   （SettingsPatch 的 profiles/apiKeys/routing 已中招修过）
> - **finalize 坑（已修）**：自检一次通过路径必须把 draft 显式传给 finalize（payload.draftText 该路径未落库）
> - 冒烟：`npm run build && node scripts/smoke-m2.mjs`（队列式 LLM stub 冒烟全链路+分叉独立演化断言，
>   scripts/smoke-llm-stub.mjs 可复用）；handlers 分域 Pick<HandlerTable,...> 标注，book:update 走 store.updateBook
>
> **M3 已完成（手机端全部页面 + Playwright 端到端联调全绿）**：
> - mobile/（独立 vite 应用）：Connect/Shelf/Onboard(四阶段)/BookWorkspace(写作·阅读·设定·线四子页)/Write(状态机：
>   现状卡→走向卡→大纲→分镜(可跳)→流式正文→自检→纪要卡)/Read(目录/正文/字号/主题/进度)/Cards(卡·人物·伏笔+钉选)/
>   Lines(分叉/切线/删除)/Settings(连接/模型/用量/APP 更新)；bridge=buildApi over fetch+SSE
> - **联调修的 2 个真 UI bug**：①installBridge 只在启动时调，首启未连接→连接后 window.api 永远缺失
>   （修：App.tsx conn 就绪 effect 补装，幂等）②useActiveJob 只返回非终态 job，done 状态永远被 find 过滤，
>   纪要卡（RecapView）永不显示（修：useJobFlow 返回 {active,lastDone}，lastDone=服务端首个 done）
> - 联调设施：scripts/smoke-m3-stub.mjs（3923，SKIP_ONBOARD=1 跳过前 4 个 onboard 响应用于已开书续写；
>   队列耗尽返回 {}，恰好暴露 autoFix 吃响应/genRecap 容错路径）+ vite preview + Playwright MCP 驱动
> - 联调路径：Connect→开新书→4 轮引导→进书→走向卡→大纲→跳过分镜→流式→一次过自检→纪要卡(人物动向/伏笔/
>  设定沉淀)→目录 2 章→正文/字号/主题→设定页(活状态 location/mood 随 recap 演化)→分叉复仇线(1 章,分叉点后
>  章节不进新线)→Settings(用量 byPurpose director 13/writer 3) 全部断言通过
> - 已知 UI 待改（M4）：onboard title 阶段确认正则不认书名文本（真实模型给书名按钮会卡，临时靠「第一个/第二个」）
>
> **M4 已完成（打磨：改章/子代理报告/动态快捷钮/onboard 正则，API 级 19 断言全绿 + M2 回归绿）**：
> - 主进程：JobKind 扩 revise/review/audit/diagnose（pump 按 kind 分发 runners 表，queued 任务统一 guarded 包装）；
>   `job:startRevise [chapterId,instruction,segment?]`（流式改章→lint 展示不入闸（targetWords=0）→replaceChapterContent
>   旧版自动进 versions）；`job:startReview/startAudit/startDiagnose`→AgentReport{verdict,findings,suggestions,score}；
>   审计门槛：章数<2 快速失败不烧模型；finalize 后有效章数 %8===0 自动排后台审计（maybeQueueAudit 去重）；
>   streamingSaver：流式 delta 每 3s 落 payload.draftText（断网/杀 APP 恢复显示）；recap 新增 quickActions
>   （agent 每章动态建议钮，genRecap 顺带产出零额外调用）；onboard 确认正则兼容书名文本（findIndex byName includes）
> - 手机端：Write.tsx 顶层按 kind 分流（SubJobView=revise 流式/改章完成 lint 简报/ReportDoneView 报告卡）；
>   IdleView 加体检台（审读上一章/全书审计/问导演+最新报告展示）；components/{QuickActionsBar,ReportCard} 共享；
>   Read.tsx 章末改章条+选段修改模式（段落化渲染点选→startRevise 带 segment）+历史版本回看（只读弹层）；
>   queries.ts useJobFlow.lastDone 限定 write kind（防 review 抢占纪要卡）+useReports
> - 冒烟：`npm run build && node scripts/smoke-m4.mjs`（19 断言：快捷钮/改章版本/审读报告/审计门槛/诊断）；
>   stub（smoke-m3-stub.mjs）尾部已加 revise/review/audit/diagnose 四响应
> - 坑：invoke 响应是 `{result}` 包装（客户端 body.result）；settings:save 切 provider 必须带顶层 `provider` 字段；
>   confirmOutline edits 不可传 null（省略或传对象）；spawn 管道 stdio 在 Windows process.exit 时 libuv 断言崩溃（用 inherit）
>
> **M5 智能体页（对话流吞掉写作流，用户验收期需求）**：
> - 手机端写作页 = 聊天时间轴（messages 表单一事实源）：user 动作=右气泡（meta.kind=action）/导演白话=左气泡（meta.kind=chat）/
>   节点卡=meta.kind=job+step（前端拉 job list 建 jobId→job 映射取 payload 渲染走向卡/大纲编辑/分镜/入书卡/报告/失败/取消）
> - 后端 jobs.ts 在状态机各转换点落节点消息（note/userMsg 辅助）；新 job kind='chat'（job:startChat [bookId,text]，
>   genChat 自由交流模式 50-300 字+不执行写作动作，history 取 meta.kind=chat 的最近 12 条——**用户发言也是 kind=chat**，
>   曾 bug：startChat 的 userMsg 默认 action 导致导演看不到用户说过的话）
> - 可交互判定：消息 jobId===active.id && active.state=waiting_user && WAIT_STEP_FOR[step]===active.step
>   （cards↔outline / outline↔scene / scenes↔draft / selfcheck↔selfcheck——waiting 挂在「下一步」上）
> - genChat 走 callRaw(params.messages/responseFormat 覆盖)；StreamingBar 恢复时从 payload.draftText 续显（streamingSaver 3s 落盘）
> - 底部输入栏：写下一章（busy 时排队提示）/审读上一章/全书审计/改这章(跳 read)+输入框（走向选择阶段=chooseDirection free，
>   否则 startChat；running 不禁用）
> - 冒烟：`npm run build && node scripts/smoke-m5.mjs`（13 断言：chat 双向落库/节点消息序列 cards→outline→scenes→chapter/
>   动作消息文案/chat 多轮）；stub 支持 CHAT_FIRST=1（chat 响应前置于写作循环）
> - M5 其余（构建链/更新源/部署）见上文 M5 段落（commit 3cece5c 起）
>
> **M6 全面 agent 化（2026-11 用户决策：写作循环改自由 agent+全 CRUD 权限+透明工具卡+只留走向确认）**：
> - 废除大纲/分镜确认与自检等待：runProposal（走向卡）→chooseDirection→**agent 自主段一路到入书**
>   （查资料→write_chapter_draft→自检（major 自动修一轮）→commit_chapter→沉淀工具→finish）；
>   contract 删 job:confirmOutline/confirmScenes/acceptFlaws 三通道
> - `src/main/agent/tools.ts`：20 个 CRUD 工具（读 9/写 7/删 4，删除类内部先 snapshotDb 自动快照；
>   patch_character_state 支持 characterId 或 name 兜底——模型常给名字）
> - `src/main/agent/loop.ts`：runAgentLoop（maxTurns 30，callRaw params 传 messages/tools/responseFormat:text；
>   assistant blocks 手工重建（ChatResult 无 blocks）+tool_result 回灌；拦截工具 write_chapter_draft/
>   commit_chapter/revise_chapter/finish 内联实现；每轮 agentSystem 重建注入 bookBasics+redlineBlock+
>   wordListBlock 防长程遗忘）；工具卡=messages 行 meta={kind:'tool',jobId,tool,summary,ok}（content 截 2000 字给作者，全文 30000 给 LLM）
> - **正负词机制（用户需求）**：books.positive_words/negative_words 两列（migrate() 幂等加列）；
>   lintChapter bannedWords=书级负向词→major（自检硬闸）；正向词仅提示不硬塞
> - 前端 Write.tsx：删大纲/分镜/自检交互组件；ToolCard 折叠卡（TOOL_LABEL 中文名+展开详情，ok=false 红色）；
>   WAIT_STEP_FOR 只剩 cards↔outline；StreamingBar streaming=write step 'agent'/revise/chat
> - genRecap/applyRecap 旧链拆除（agent 实时沉淀取代）；revise/review/audit/diagnose 保留独立 job
> - 冒烟四套全绿：smoke-m6（agent 全链路 18 断言含负向词自动修+工具卡序列+chat 带工具）；m2/m4/m5 已迁 AGENT_MODE 队列
>   （**stub 队列顺序敏感**：AGENT_MODE=1 队列=directions→agent 链→chat×3（CHAT_IN_QUEUE=0 跳过）→revise→review→diagnose；
>   冒烟脚本必须设 negativeWords=['忽然'] 触发 autoFix 轮，否则队列错位）
> - 坑：chooseDirection 返回的是 runAgentChapterJob 完成后的终态 Job；loop.ts 的 `let book: Book` 显式标注
>   （闭包内窄化丢失）；stub 一次性给完整 tool_calls chunk（llmOpenai 按 index 累积兼容）
>
> **M7 智能体页重构（2026-11 用户决策：聚合条+全对话化+串流根修）**：
> - **统一原则**：一切生成内容（正文/改章/设定…）不进聊天流式——agent 一律调工具产出，聊天流只有
>   对话气泡+工具卡+成品卡；过程进度走聚合条。入书卡是正文唯一正式出场（payload.draftText 可展开）
> - 事件三通道：`job:activity`（工具卡实时推，agentSay 落库+emit 同步）、`job:progress`（正文/改章
>   字数进度，progressSaver）、`job:delta` 改三参 (jobId,text,**total**)——chat 白话流式带累计长度，
>   前端失配时 job:get 拉 payload.answer 兑底（服务端唯一真相源，根治串流/重复/错乱）
> - streamingSaver 已拆：chatSaver（白话+payload.answer）/progressSaver（正文+payload.draftText）
> - **全对话化**：InputBar 删全部快捷钮；free 模式三意图工具 propose_chapter{directionHint?}/
>   request_review{chapterId?}/request_audit（actions 注入：startChapter fire-and-forget 排队/
>   genReview/genAudit 转文本回聊天流）；startWrite(bookId,hint?) 倾向贯穿到 genDirections
> - 前端 Write.tsx：StatusHead 一行胶囊（点开全卡）；AgentTicker 聚合条（活动流+进度行+▼步数列表+
>   chat 流式光标+取消）；正文流式渲染整体移除
> - 冒烟回归四套全绿（m6 18/m2 23/m4 18/m5 14）——M7 未加新断言（activity/progress 事件层，
>   真机验收覆盖）

## 常用命令
- `npm run dev` 启动开发（Electron 窗口）
- `npm run typecheck` 三套 tsconfig（node=主进程/preload，根=renderer，mobile）类型检查
- `npm run build` 产物到 out/
- `npm run dist` 打包 NSIS 安装包到 dist/（需先 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`，否则国内下载 Electron/NSIS 会超时）
- `npm run lint` / `npm run lint:fix`：Biome 检查/修复（lint+format 一体）；门禁 = typecheck + lint 双绿

## 版本号
- 根 `package.json` 的 `version` 是 semver 单一事实源。`npm run apk` 时经 `scripts/version.mjs` **按 Conventional Commits 自动推进**：自最新 `v*` git tag 以来，breaking（`!` 或 `BREAKING CHANGE`）→ major、`feat` → minor、`fix`/`perf` → patch，其余类型（chore/docs/refactor…）不升。
- 每次推进自动打 `v<semver>` tag 作为下次基线；仓库无 tag 时首跑在当前 HEAD 建基线、本次不升版。手动 `npm run apk -- 2.0.0`（或直接跑 `node scripts/version.mjs`）可覆盖/单测，加 `--dry` 只算不写。
- APK 的 `versionName = <semver>-<yyyymmddHHMM>`（时间戳保证同一 semver 多次构建仍唯一），`versionCode` = 分钟级 epoch 的 int（单调递增，手机端判新只看它，故改 semver 不影响更新检测）。

## 项目级 skill
- `.opencode/skill/reload`：`reload`（=重启/重启项目/重启一下）= 完整重启 dev 实例 + 验证（3910/5173 监听、`nmtest123` 表单登录 302、远程可达）。详见其 SKILL.md。
- `.opencode/skill/reviewer`：`reviewer`（=review/代码审查/审查一下）= 对代码改动产出分级审查报告（F 编号，含 typecheck+lint 门禁）；**每完成一次编码工作后必须自动调用它审查本次改动**，报告确认后按编号修复。详见其 SKILL.md。

## 架构
- **AI 收敛原则（2026-10）**：全应用唯一的 LLM 生成入口是智能体页；各页面只保留手动编辑与只读展示（卷摘要等由 agent 工具落库后展示）；`llm:chat` 流式通道仅剩 Playground 使用；已拆除的能力（管线生成/批量写作/编辑器 AI/向导生成）不要轻易复活，新写作能力一律做成 agent 工具。
- `src/main/` 主进程：`llm.ts`（Anthropic 兼容流式客户端，支持 tools/tool_use 流解析；工具参数 JSON parse 失败不落 `_raw`，改结构化 `inputError:'truncated'|'invalid'`（run/subagent 据此发错误 tool_result 引导重试；shared/toolInput.ts 的 recoverToolInput 负责历史 `_raw` 回灌解包）；`probeModels` 按 provider 分流探测：glm/custom 走 `/v1/models`+x-api-key，deepseek 走根域 `/models`+Bearer，ollama 走 `/v1/models` 失败回退 `/api/tags`）、`providers` 预设见 `src/shared/providers.ts`（glm/deepseek/ollama/lmstudio/custom：baseUrl、默认模型、内置模型列表、needsKey、supportsCache、maxOutputTokens（glm 16384，其余 8192；toolkit.agentMaxTokens() 取值）、文案）、`agent/`（智能体 agentic loop，按域拆 toolkit/tools/subagent/run + index barrel：**全应用唯一 LLM 生成入口**，38 个工具绑定当前项目 CRUD，删除类与覆盖正文需 renderer 确认，maxTurns 24；list 类工具带过滤/分页/摘要，单次工具结果上限 30000 字，截断时返回补救指引；写章闭环纪律见 buildSystemPrompt 规则 9：get_chapter_context（context.ts 工具化，动笔前必调）→ append_chapter 分段追加（≤3000 字/次）→ lint_chapter 硬闸自检 → save_summary 收尾；update_instruction_section 按节改写全局/项目指令；技能索引+always 常驻注入系统提示、load_skill 按需加载全文；get_book_digest 全书概览、update_character_state、search_project 语义检索、get_chapter_tail 写前回读）、`agentTranscript.ts`（agent 会话持久化到 SQLite agent_sessions/agent_events 表，旧 agent_sessions.json 已迁 .bak；shared/agentTranscript.ts 负责历史回灌投影）、`graph.ts`（全项目知识图谱构建：扫各板块+章节正文的 `[[]]` 生成节点/边/度数，节点携带 tags；`[[目标|关系]]` 类型化边聚合为边标注，未命中目标的引用进 danglingLinks 供悬空检测）、`settings.ts`（safeStorage 按 provider 分别加密 API Key；`provider` + `profiles`（各 provider 独立 baseUrl/defaultModel/modelRouting/promptCache）+ `apiKeys`，旧单 key/baseUrl 读取时自动迁移为 glm；`getLlmAuth()` 为基础鉴权入口，`resolveRequestAuth(purpose)` 为按用途跨 provider 路由入口（路由值兼容 string 与 {provider,model}，目标 provider 未配 Key 时回退当前 provider 并发 `llm:notice`））、`usage.ts`（usage_log.jsonl 记账）、`db.ts`（node:sqlite 建库+迁移）、`store.ts`（项目/大纲/人物/世界观 CRUD + worldbuild_types 受控类型表（带 priority 排序：预设 地理<势力<历史<力量体系<物品，其他恒最后，同优先级拼音序），tag 与 type 命名互斥；worldbuild.keys 检索别名；大纲元数据 6 列（role/suspense/twist/hook/foreshadow_ops/scenes，scenes 为 JSON 字符串数组）、characters.state 活文档、foreshadows.planned_resolve/priority、volume_summaries 表；summaries.content JSON 内含 ledger 硬账（无独立列）；worldbuild 改标题时 `[[旧]]→[[新]]` 全局传播；**章节自动编号（2026-10）**：outlines.sort_key 是排序事实、chapter_no 只是位置派生缓存（插/删/移动后 refreshStructure 事务内稠密重算，+100000 偏移规避 UNIQUE 碰撞），saveOutline 直接改 volume/chapterNo 即移动语义；伏笔 planted/planned_resolve/resolved 三组字段各带 `*_outline_id` uid 列（展示层经 shared/foreRef.ts 解析为当前章号，悬空标红回退旧文本），启动迁移把存量「第N章/第V卷N-M章」文本回填 uid）、`skills.ts`（技能加载与 seed+prune：内置缺失写入、version 更高覆盖、REMOVED_BUILTIN_SKILLS 清残留）、`builtin-skills.ts`（13 个内置技能模板，均已适配 agent 工具语境）、`embedding.ts`（本地语义检索：transformers.js + bge-small-zh-v1.5 q8（约25MB 首用下载至 userData/model-cache，默认 hf-mirror，可用 HF_ENDPOINT 覆盖）；懒加载、内部队列串行嵌入（worldbuild/character 保存与 save_summary 后自动入队）、SQLite embeddings 表存 Float32 BLOB、余弦相似度 JS 计算；模型不可用自动降级返回空结果，调用方回退图谱/关键词路径）、`lint.ts`（零成本硬闸：接缝重复（与上一章尾重叠）/穿帮词黑名单/元语言泄漏（含 `<!--NEW-->` 注释残留，保存前 strip）/完全重复段/字数达标；lint:run handler 供渲染端调用、lint_chapter 工具供智能体自检）、`context.ts`（章节上下文构建：元数据+本章场景序列（scenes 有才注入）+下一章预告+人物动态状态+伏笔（含计划回收/优先级）+更早各卷卷摘要分层注入+上一章硬账台账；世界观 ≥40 条时子图模式——标题∪别名 keys∪`[[链接]]` 命中 ∪ 语义 top-8 ∪ 1跳邻居，按融合分（提及 0.6+语义 0.35+度数）重排，预算 8000 字，其余降级标题清单；async 签名；经 get_chapter_context 工具暴露）、`ipc.ts`
- `src/shared/`：`types.ts` 共享类型、`tags.ts` tag 解析（`splitTags` 宽容分隔符、`splitHeadingHashtags` 剥离标题行尾 `#tag`）、`wikiLinks.ts`（parseWikiLinks：[[目标|别名]]/[[目标]] 去重保序）、`toolInput.ts`（recoverToolInput：工具参数 `_raw` 解包恢复）、`agentTranscript.ts`（turnsToMessages 会话回灌投影，解不开的 `_raw` 整对跳过）、`foreRef.ts`（伏笔章号 uid 解析）
- `src/main/` 通信层：`handlers/`（**传输无关的业务 handler 按域拆分**：index.ts 汇总 `sharedHandlers`（同时供 Electron IPC 与内嵌 HTTP）+ `ipcOnlyHandlers`（仅桌面端，exporter:run）；context.ts 的 HandlerTable 从契约派生；stream.ts 承载 startStream/startAgentRun 等流式编排，只依赖 `EventSink` 抽象事件出口，内置运行注册表（rid→status/payload/meta，TTL 10min，是 `llm:poll` 与 `runtime:snapshot` 补拉的数据源）、runtime.ts（`runtime:snapshot` 返回全部在途/近期 run）、`eventSink.ts`（`EventSink` 接口）、`server.ts`（内嵌 `node:http` 服务：静态/开发反代、`/api/invoke/:channel` JSON-RPC、`/api/events` SSE 广播、`/api/login`+cookie 会话鉴权、`/api/export` 下载；scrypt 密码哈希；启动时自动选局域网 IPv4，物理网卡优先、排除 VMware/Tailscale 等虚拟网卡）、`serverState.ts`（服务器运行状态单例，供 `server:status` 只读查询）、`ipc.ts`（薄封装：遍历 handlers 注册 `ipcMain.handle` + `exporter:run`（原 export:run）+`server:config` 两个桌面专属通道）
- `src/preload/index.ts` contextBridge 暴露 `window.api`（含 `api.agent`、`api.graph`、`api.server`）
- `src/renderer/src/web-bridge.ts`：**同源浏览器适配器**，在 `main.tsx` 首行 import；若 `window.api` 不存在（非 Electron）则用 `fetch /api/invoke/:channel` + 单例 `EventSource('/api/events')` 实现完整 `Api`，业务代码零改动。Electron 下 preload 已注入故直接跳过；`window.__NM_WEB__` 标记浏览器环境（设置页用它隐藏服务器配置）
- `src/renderer/` React + Tailwind v4；**数据层 = TanStack Query**（`lib/queries.ts` 的 qk 前缀 key + queries 工厂；写后按前缀 invalidate；App.tsx 挂 llm:done/agent:done 全局失效），**UI 态 = zustand**（toastStore/agentUiStore + wizard/ 的 agentRunStore/agentTabsStore，外部命令式走 `store.getState()`）；QueryClientProvider 在 main.tsx；编辑器正文类有脏状态的数据**不要**转 query 自动 refetch；响应式：
- `src/wizard/` 桌面/移动共用业务组件包（平铺；现仅剩 AgentInstructionsPanel 指令面板、PremisePanel 基本设定元表单、OverlayCard、agentRunStore/agentTabsStore、notify/toastStore、uiTypes+两端换肤（mobile 用 mobileWizardUi，桌面用 desktopWizardUi））；AI 生成类组件（CharacterGenPanel/volumeGen/wbGen/ChainBanner/writeRunStore/runtimeSync/pipeline 客户端封装等）已全拆——AI 能力收敛智能体页（2026-10）；**新顶层目录必须同步加进 tsconfig include**（见坑 28）
- 用户数据在 Electron `userData` 目录：`settings.json`、`usage_log.jsonl`、`data/novel.db`（含 agent_sessions/agent_events 表）、`skills/*.md`（旧 agent_sessions.json 已迁 .bak）

## 踩坑记录
1. **依赖版本钉死**：electron-vite@5 的 peer 只支持 vite ^5||^6||^7，不要升 vite 8；vite 7 对应 `@vitejs/plugin-react@^5`（v6 要求 vite 8）。
2. **Electron 二进制下载**：项目 `.npmrc` 的 `electron_mirror` 会被 npm 11 警告 Unknown config 且 postinstall 拿不到，导致 `electron-vite dev` 报 `Error: Electron uninstall`。修复：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`。node_modules 重装后要检查 `node_modules/electron/dist/` 是否存在。
3. **preload 产物是 `out/preload/index.mjs`**（type:module 下），主进程加载路径要写 `index.mjs` 不是 `index.js`；main 产物仍是 `index.js`。
4. Git Bash 里 taskkill 需要 `MSYS_NO_PATHCONV=1`，否则 `/F /T /IM` 参数被误转成路径。
5. **原生模块一律不用，SQLite 用内置 `node:sqlite`（DatabaseSync）**：Electron 44 内置 Node 24.20，node:sqlite 可用且带 FTS5。better-sqlite3 在 electron 44 ABI 无 prebuild、本地编译需要 VS Build Tools（本机没有），已验证不可行并卸载。
6. 杀测试用 electron 进程时用 PowerShell 按启动时间过滤（`Get-Process electron | Where StartTime < 2min`），避免误杀用户自己开着的 dev 实例。
7. **`electron-vite dev -- --remote-debugging-port=9222` 的传参在主进程热重启后会丢失**：要稳定的 CDP 调试口，用环境变量 `NM_REMOTE_DEBUG_PORT=9222 npm run dev`（index.ts 里 appendSwitch）。
8. **无 GUI 端到端联调**：起带 CDP 口的 dev 实例后，用 node 脚本 `fetch http://127.0.0.1:9222/json/list` 拿 page target 的 webSocketDebuggerUrl，经 WebSocket `Runtime.evaluate`（awaitPromise）在渲染进程直接调 `window.api.*` 完整走 IPC/LLM 链路。GLM 的 Anthropic 兼容端点 `/v1/messages` 对 tools/tool_use 支持已实测可用（glm-4.6）。
9. **Anthropic tool use 消息约束**：assistant 消息中每个 tool_use block 必须在紧随的 user 消息里有对应 tool_result，否则下轮请求 400；重建对话历史时必须跳过被中断（无 result）的 tool_use。
10. **react-markdown 的 `defaultUrlTransform` 只放行 http(s)/mailto 等白名单 scheme**：自定义 scheme（如 wikilink 的 `wiki:`）会被清成空 href，需传自定义 `urlTransform` 对前缀放行；`[[x]]` wikilink 是在自定义 remark 插件里切 AST text 节点为 link 节点实现（见 components/Markdown.tsx）。
11. **编辑器即时渲染方案已放弃**（2026-09）：vditor IR 试用后回退（wikilink `[[x]]` 无法在编辑态渲染、ir 模式 destroy 必崩、cdn 需复制 public 资源），编辑用 AiTextarea（2026-10 起为纯 textarea 外壳，AI 改写已收敛智能体页），仅展示侧用 Markdown 组件渲染。若再尝试 WYSIWYG 需先解决自定义语法在编辑态的渲染（如 milkdown 自定义节点）。
12. **electron-vite dev 不热重载 `src/shared/`、`src/preload/` 改动且 touch 不触发 rebuild**：改 shared 后主进程仍跑旧代码（renderer 却 HMR 了，极易误判已生效）；改 preload 后 renderer HMR 的新代码会调用旧 preload 产物里不存在的方法（表象：`window.api.xxx is not a function`，确认 out/preload/index.mjs 里 grep 不到新方法即中招），都必须重启 dev 实例再验证；CDP 口被刚杀实例占用时（TIME_WAIT）新实例 bind 失败且无 9222 监听，直接换 `NM_REMOTE_DEBUG_PORT` 端口重启。
13. **CDP evaluate 模拟 UI 的两个坑**：①直接调 `window.api.settings.save` 不触发 App 内部 refresh，`currentProject` 不会生效，save 后 `location.reload()` 再操作；②全局按文本找 button 会撞侧栏 nav（如「图谱」），用 `button:not(aside button)` 限定主内容区。
14. **GLM Anthropic 兼容端点的 thinking 陷阱**：glm-4.6 会默认启用思考且思考 token 计入 `output_tokens`，但思考内容**不经过 text_delta**——长输出任务的 max_tokens 会被思考吃光，正文只收到极少字符甚至为空（表象：usage 显示 8192 tokens 但 parse 出空「未命名条目」）。修复：请求体统一带 `thinking: {type:'disabled'}`（llm.ts chatStream），agent 主请求 maxTokens 经 toolkit.agentMaxTokens() 按 provider 取 providers.maxOutputTokens（glm 16384，其余 8192）；判断依据：outputTokens 远大于 text 长度即中招。
15. **内置 skill 的 version 是覆盖开关**：frontmatter 无 version 视为 0，改 `builtin-skills.ts` 里的 skill 后必须 bump version 才会覆盖 userData/skills 下的旧副本（现为 worldbuilder v10、outline-architect v7、chapter-writer v4、character-smith v4、chapter-reviewer v3、summarizer v4、style-polisher v3、continuity-checker v2、state-syncer v2、chapter-expander v2、foreshadow-tracker v1、context-compactor v2、volume-summarizer v1；segment-planner 已删且启动时 prune 残留副本）。内置技能均已适配 agent 工具语境（落库走 save_* 工具而非 JSON 输出协议）；智能体系统提示注入技能索引与 always 常驻全文，细项经 load_skill 按需加载；标签纪律仍同步写进 `buildSystemPrompt` 与工具描述。
16. **内嵌服务器 / 手机浏览器版**（2026-09）：同一份 renderer 产物双端运行——Electron 走 preload 的 `window.api`，浏览器走 `web-bridge.ts`（检测 `window.api` 缺失才安装），因此**不要把 renderer 业务代码写成只依赖 IPC 特有的东西**；新增 IPC 接口时必须同步补 `preload/index.ts` 与 `web-bridge.ts`（`Api` 类型会强制校验）。注意：①`server:config` 故意只走 IPC（放 `ipc.ts` 而非 `sharedHandlers`），防止手机端改端口/密码把自己锁死，浏览器调用会 reject；②SSE 只广播给浏览器客户端、IPC 只推给 Electron 窗口，两者 sink 独立，靠 `requestId` 过滤同源多标签；③dev 下 `server.ts` 优先反代 `ELECTRON_RENDERER_URL`（含 `upgrade` TCP 透传以保 HMR），生产才读 `out/renderer`；④局域网 IP 选择要给接口名打分（物理网卡优先，VMware/vEthernet/Tailscale/169.254 靠后），否则会挑到虚拟网卡不可达；⑤未设密码时仅 `127.0.0.1` 放行，设密码后所有来源（含本机）都要 cookie 会话；⑥重启服务用 `server.closeAllConnections()` 防 keep-alive 连接阻塞。
17. **多 provider（GLM/DeepSeek/Ollama）接入只走 Anthropic 兼容协议**（2026-09 实机验证）：DeepSeek 官方端点 `https://api.deepseek.com/anthropic`（不支持模型名自动映射到 `deepseek-flash`），本地 Ollama `/v1/messages`（需 v0.12+，无需 Key，代码里用占位 `'ollama'` 走 x-api-key）。注意：①Ollama 不支持 `cache_control`、无 `/v1/models` 的 Anthropic 形态，探测要回退 `/api/tags`；②DeepSeek 模型列表在根域 `/models` 且用 Bearer，探测时要剥掉 `/anthropic` 后缀；③DeepSeek/Ollama 下 promptCache 必须强制关（否则发出未支持的 cache_control）；④Ollama 实机跑通 agent 全链路（qwen3:14b 工具调用/tool_result 回灌正常）。
18. **transformers.js 本地嵌入只做懒加载**：`embedding.ts` 里 `await import('@huggingface/transformers')` 必须保持在 `ensurePipeline` 内部（首条嵌入才触发），顶层静态 import 会拖慢主进程启动且 dev 下每次重启都加载 onnxruntime；打包时 electron-builder 需 asarUnpack transformers/onnxruntime（已在 package.json build 配置）；模型缓存目录 `userData/model-cache`，remoteHost 默认指 hf-mirror，`HF_ENDPOINT` 可覆盖。任何失败路径都必须静默降级（semanticSearch 返回 []），绝不能把嵌入故障抛给写作主链路。
19. **skills seed 依赖启动时 `listSkills()`**（index.ts whenReady 已调用）：新增/修改内置 skill 只要 bump version 就会在下次启动覆盖 userData 副本；seedIfEmpty 同时 prune REMOVED_BUILTIN_SKILLS 残留；若 seed 链路被改动（如从 index.ts 移除 listSkills），新装环境的 skill 会缺失——改启动序列时务必保住这一步。
20. **typescript-eslint 与 TS7-native 不兼容**：`typescript@7` 是 native 包（无 JS API），typescript-eslint 钉死 `<6.1.0` 且 npm 同名包无法双版本共存——lint 只能选 Biome（不依赖 TS API）。勿再尝试 eslint 路线，除非 TS7 提供 JS API 且 typescript-eslint 放开约束。
21. **Biome 的 CSS 解析要开 `css.parser.tailwindDirectives`**（styles.css 用了 `@apply`）；a11y 规则对多行 JSX 的 `<button>` 无 unsafe fix，需 codemod 补 `type="button"`；**JSX 属性间的 biome-ignore 注释合法**（写在 key={i} 上一行），但抑制 hooks 依赖必须放在 `useEffect(` 起始行上一行，放 deps 数组行上一行（effect 体内）是 unused suppression。
22. **契约层注意事项**：`'export:run'` 已更名 `'exporter:run'`（ns:method 派生 uniform）；`ArgsOf<C>` 这种 z.output 泛型不能直接当 rest 参数（TS 无法证明是元组），handler 统一收单元组参数再解构。
23. **handler 元组绝不能再 spread**：handler 契约是 `(ctx, args: 元组)`，函数体内 `([x])` 解构元组——调用方（ipc.ts `ipcMain.handle` 与 server.ts `handleInvoke`）必须 `handler(ctx, args)` **整体传递**；曾因写成 `handler(ctx, ...args)` 导致所有带参调用在运行时炸 `object is not iterable`（TS 被 cast 掩盖不报错，桌面 UI 实际全坏）。判据：ipcMain 回调 `(e, ...args)` 收到的 args 本身就是元组，直接透传即可。
24. **手机 APP 架构（2026-09）**：瘦客户端——APK（Capacitor 壳 `mobile-app/`）加载本地 web bundle（`mobile/` 独立 vite 应用，build 到 `dist-mobile/`），经 Tailscale 调电脑端内嵌服务器；**Tailscale IP 写死在 `mobile/src/lib/conn.ts` 的 DEFAULT_BASE_URL**（100.100.62.8:3910，连接页可改），`npm run apk` 一键构建并部署（vite build→pack-mobile 部署电脑端→sync-bundle→cap sync→assembleDebug→拷为根目录 NovelMaker.apk）；鉴权用 `x-nm-token` header / `?token=`（APK WebView 跨站 SameSite cookie 不可用），token 由 `POST /api/mobile/auth`（密码换 token）签发；更新统一走 **APK 自更新**（bundle 增量更新已废弃拆除）：More 页「APP 更新」检查 `/api/mobile/version` 的 `apk` 字段 → Capacitor 插件 `ApkUpdaterPlugin` 下载到 cacheDir（进度经 listener 回 JS）→ FileProvider+ACTION_VIEW 调起系统安装器（必弹系统确认）；API 26+ 需 canRequestPackageInstalls 授权（无授权跳 ACTION_MANAGE_UNKNOWN_APP_SOURCES，resolve needsGrant 让 JS 进 grant 态提示用户）；**registerPlugin 必须在 super.onCreate 之前**（Bridge 在 super.onCreate 内收集插件表，晚注册报 plugin is not implemented，实锤 464f2bf）；版本号由 build-apk.mjs 生成 `version.properties`（versionName=时间戳、versionCode=分钟级 epoch，勿超 int）注入 gradle；pack-mobile.mjs 已简化为 APK-only 部署（`--apk --apk-version` 参数）；8899 端口手动下载保留为备用。

25. **浏览器端「无响应」先查 SSE 生命周期**（2026-09 实锤）：web-bridge 的 EventSource `onerror` 后若 readyState===CLOSED，浏览器**不会自动重连**——invoke 照常成功但 llm:delta/done 永远收不到，表象是手机端永远「生成中」+流式框空白（Electron IPC 路径此时完全健康，极易误判为主进程问题）。现有防御三层：web-bridge 指数退避重连（1s→15s，reconnectTimer 防重入）+ `nm-sse-state` CustomEvent 驱动 App.tsx 断连横幅（仅 `window.__NM_WEB__`）+ lib/ipc.ts `subscribeStream` 300s 看门狗兜底解除 busy。排查时用 usage_log 判断请求是否真发出：有记录+UI 无响应=SSE 断；无记录=请求没发出（auth/契约层）。
26. **新增顶层目录必须同步 tsconfig include**：`src/wizard/` 迁出后若 tsconfig.json（三套都要看）include 没加，该目录文件完全脱离 typecheck——坏 import/类型错误全部假绿，只在 vite 运行时才炸。新建顶层目录后第一时间检查所有 tsconfig 的 include。
27. **起 dev 实例的命令绝不能长挂**：即使 `Start-Process npm.cmd` 已脱离 shell，若同一条 bash 命令里还串了探测/等待（`&& sleep` 链），命令超时被杀时**级联杀掉刚起的 dev 实例**。正确姿势：起实例的命令立即返回，端口/日志探测用独立的短命令轮询。
28. **Tailwind v4 自动源检测不覆盖 `src/wizard/`**（2026-10 实锤）：v4 从 vite root 自动扫描只覆盖 `src/renderer/`，`src/wizard/` 独有的类（如裸 `grid-cols-3`、`h-6`、`tracking-wide`）**不生成 CSS**——向导 UI 半裸奔但难察觉，因为多数类恰与 renderer 重叠。修复：`src/renderer/src/styles.css` 与 `mobile/src/styles.css` 都显式 `@source`。判据：对某类疑似无样式，createElement 挂载探针读 computedStyle 验证；grep 该类是否只在 wizard 出现。
29. **`@source` 路径相对所在 CSS 文件解析，抄错深度=静默失效**（2026-10 白框事故终局）：`mobile/src/styles.css` 曾照抄 renderer 的 `@source "../../wizard"`——从 `mobile/src/` 出发指向项目根的**上一级**（不存在），Tailwind 不报错、向导类全缺，APK 里向导弹窗白框+样式裸奔。正确写法 `@source "../../src/wizard"`。同族坑：`build-apk.mjs` 若以 `mobile/` 为 cwd 跑 vite build，扫描 base 跟随 cwd 也会漏扫（已改为根 cwd + 显式 `--config mobile/vite.config.ts`）。**防线**：`scripts/check-tailwind-classes.mjs` 哨兵校验（每扫描源一个代表类，缺失即构建失败），已接入 `npm run build`（桌面 out/renderer/assets，默认组）与 `npm run apk`（dist-mobile/assets，`--mobile` 组）；新增扫描源时须在脚本里补对应哨兵类。
30. **渲染端 hooks 必须在所有 early return 之前**（2026-10 手机黑屏实锤）：mobile Write.tsx 曾把 `useWriteListStore` 两个 hook 放在 `if (selected) return <ChapterEditor/>` 之后，点进章节该次渲染少声明 2 个 hook → React 抛 "Rendered fewer hooks than expected"，Android WebView 表现为**整页黑屏卡死且无任何报错 UI**。判据：点进子视图瞬间黑屏、桌面/日志无明显异常，先查 hook 声明顺序。
31. **章节状态链是「chapters.status 落后、outlines.status 才是新」**（2026-10）：save_chapter 只把 chapters.status 写 draft，save_summary 落摘要时经 `raiseChapterStatus()`（store.ts，rank 只升不降）把状态升为 written 并同步 outlines.status；手机徽章若优先显示 chapterStatus 会把已写章显示成「草稿」——用 `briefBadgeStatus()`（chapterStatus 仅 polished/approved 才采信，否则回退 outline status）。
32. **web-bridge invoke 必须带超时**（2026-10 实锤）：无超时的 fetch 在响应丢失时 Promise 永久悬挂（不 resolve 不 reject，调用方 .then 永不执行且无任何报错）。已修：invoke 统一 `AbortSignal.timeout(30s)`+友好超时报错。判据：主进程确实在跑（usage_log 有记录）但 UI 无反应=响应丢失；无记录=请求没发出（auth/契约层）。

33. **版本号自动推进的边界（2026-10）**：`scripts/version.mjs` 按 Conventional Commits 自最新 `v*` tag 推进并自动打 tag（`npm run apk` 触发）。已知边界：①tag 打在 HEAD，而 `package.json` 的版本改动未必已提交，故 `vX.Y.Z` 指向的提交里版本号可能仍是旧值（可追溯性瑕疵，不影响基线计算）；②bump+tag 发生在构建之前，构建失败会留下「有 tag 无产物」；③`git log <tag>..HEAD` 在最新 tag 不在当前分支祖先链（多分支各自打 tag / 浅克隆）时会纳入无关提交致过度升版；④tag 已存在时**严格抛错**（不会静默写坏 package.json）；手动 `npm run apk -- X` 只补打基线 tag、不自动 bump。

34. **CDP 冒烟 import 模块必须动态发现真实 URL**（2026-10-05 实锤，曾浪费多轮排查）：vite dev 下被 HMR 更新过的模块，页面真实 URL 带 `?t=<时间戳>`，与无参 URL 是**两个独立模块实例**——脚本硬编码 `import('/@fs/.../agentRunStore.ts')`（无参）拿到的是幽灵实例，读 store/手动调函数全作用在假实例上，观测全错且「手动修复成功」也是假象（此前会话能 PASS 只因测试实例刚起、无 HMR 时间戳）。修法：import 前用 `performance.getEntriesByType('resource')` 找含目标文件名且带 `?t=` 的最新 URL（无则回退无参）；脚本判定条件还要覆盖「恢复时已收尾」分支（requestId 可能已被 settle 清空）。判据：观测结果与 runRecords/快照明显矛盾时，先打印 resource URL 核对实例一致性，勿急着改代码。
35. **测试实例与测试任务的前置检查**：①主进程有 `requestSingleInstanceLock`（index.ts）——第二实例**无痕秒退**（日志看似正常构建中），起测试实例前先杀日常实例（PowerShell 按 StartTime 过滤），起后必须确认 CDP 口真在 LISTEN 再开跑；②测试 agent 任务前确认 provider 余额（deepseek 余额耗尽会以 error 收尾，易与「恢复链路 bug」混淆判定）；测试任务措辞强硬（「立即调用 xxx 工具…不要询问」）或直接 `window.api.*` 构造数据，防弱指令遵循模型把任务带偏成文字讨论。

36. **改 agent 工具集的三处映射 + CDP 事件等待模式**（2026-10 实锤，一次 300s 白等 + 一次 APK 重建返工）：①工具名映射有**三处**——`agent/tools.ts` 定义、渲染端 `src/renderer/src/lib/agentTurns.ts`、**手机端 `mobile/src/lib/agentTurns.ts`**（后两处是独立副本，缺失只退化为裸名不报错，极易漏；全仓 grep 必须含 `mobile/` 目录，只搜 `src/` 会漏）；新增/合并/改名工具前先全仓 grep 旧工具名（含 spawn_subagent 描述里的白名单文案、buildSystemPrompt 规则、SUB_TOOLS/READ_TOOLS）。②`window.api.agent.run()` 返回 **Promise<rid> 不是 rid**——CDP 脚本拿返回值直接与事件 id 比较永远不等，onDone 永不触发、eval 白等到超时（run 本身秒完，usage_log 有账，极具迷惑性）；正确模式：先注册收集器把 done/error 全收进数组，`await` rid 后轮询匹配并带总超时。③工具结果事件（agent:toolCall）若主进程某分支漏发，渲染端不会生成工具卡，依赖「按 name 找卡」的持久化逻辑会静默 no-op——新工具进 dispatch 流必须与老工具同样先发 toolCall 再发 toolResult。④手机端症状「工具能执行但 UI 显裸名」= APK bundle 旧 + 主进程新——重建前先 `grep dist-mobile/assets/*.js` 确认标签已进 bundle 再交付。

## 约定
- API Key 仅存主进程（safeStorage，按 provider 分别保存），渲染进程只拿到掩码；LLM 调用统一走主进程（Electron 经 IPC，浏览器经密码鉴权的内嵌 HTTP），provider 鉴权统一走 `getLlmAuth()`（Ollama 无需真实 Key，用占位符）；带 purpose 的请求一律经 `resolveRequestAuth(purpose)` 解析（跨 provider 路由 + 未配置回退；purpose 现仅 playground/summary/agent）。
- 新增桌面/浏览器共用能力时，业务逻辑写进 `handlers/` 域文件的 `sharedHandlers`（而非 `ipc.ts`），敏感/桌面专属操作放 `handlers/ipcOnly.ts` 或 `ipc.ts`；通道签名一律先改 `src/shared/contract.ts`（zod 单一事实源，preload/web-bridge/HTTP 校验三端自动派生，详见 .opencode/skill/nm-conventions）。
- 每次请求必须 appendUsage 记账（M2 额度展示依赖 ratelimit 头字段实测结果）。
- 更新型写入语义：可选字段未传（undefined）保留原值，显式空串才清空（`store.saveWorldbuild/saveCharacter/saveOutline/saveForeshadow`）；AI 修订/agent 保存若没输出 tags 一律保留旧标签，避免只改正文时清空标签。
- 世界观引用优先写 `[[目标|关系短语]]`（Obsidian alias 语法）：graph.ts 解析为类型化边、Markdown 组件显示关系短语、export 剥离为纯文本；裸 `[[目标]]` 仅作简单关联。改标题时 store 自动全局传播旧链接。
- 测试收尾必须帮用户重启服务：实测套路杀掉测试 electron 实例后，用 `Start-Process npm.cmd -ArgumentList 'run','dev' -WorkingDirectory <root> -WindowStyle Hidden` 立即拉起用户日常 dev 服务（命令单独发、立即返回，不与探测串同一条命令），再独立轮询 3910 确认 UP；settings.json 已还原用户原密码后服务才可交付。
