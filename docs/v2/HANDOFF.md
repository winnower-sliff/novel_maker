# 任务交接板

## 进行中：移除 GLM + 为 DeepSeek 做更强的长期记忆（2026-11-27 开工）

- 用户指令（原话）：「继续自己检查问题并修复。在APP中取消使用glm的能力。在该APP使用dpsk的时候幻觉和遗忘很严重。
  参考最新的功能为APP提供更复杂高效的长期记忆能力，以维持更好的风格统一与逻辑一致。」
- ① APK 安装故障——**已完成**（见下方「APK 自更新故障修复」）。
- ② 移除 GLM 能力——**已完成并上线**（2026-11-27，合并提交 `1b1e9c1`；随 APK **v4.9.0-202611270122** 出包，
  电脑端 4.9.0 已部署，worktree 已移除）。分支上四个提交：`37db83b fix(config)` 加载时清洗旧配置
  （`config.ts` 的 `sanitize()`：仅内存、不改名、不落盘，合并一条 `[config]` 日志）、`07b109a refactor(provider)`
  删 GLM 预设、默认 DeepSeek、设置页只剩 DeepSeek / 自定义、`5a12eba test(config)` 新增
  `scripts/smoke-config.mjs`、`644abd0 docs`（AGENTS.md、DECISIONS A7-R）；子代理跑过 `npm test` 20 套全过。
  以下是实施前的调查结论与做法（留档）：
  生产 `settings.json`：provider=deepseek
  （模型 `deepseek-v4-pro`），只存了 DeepSeek 的 Key，`routing` 为空，`profiles.glm` 残留。
  调查结论（已核实代码）：
  - `config.ts` 的 `load()` 不走 zod，只有 `JSON.parse` 抛错才改名 `.corrupt-<时间>` → 残留 glm
    **不会**让整份配置被判损坏；但若 `routing` 里有槽指向 glm，`defaultProfile` 会抛 TypeError、任务 failed。
  - 落点：`src/shared/providers.ts:3,6,26-37`（预设与 `ProviderId` 枚举）、`src/main/config.ts:42`
    （默认 provider）、`mobile/src/pages/Settings.tsx:13-17,396`（供应商按钮写死数组）、
    `AGENTS.md:49`、`docs/v2/DECISIONS.md:23`（A7 明文含 GLM，移除属决策变更，须追加条目）。
    冒烟全用 custom，无断言要改；`HISTORY.md`/`LEGACY.md` 是历史记录不改。
  - 做法：枚举与预设删 glm → 默认 provider 改 deepseek → `load()` 加清洗（无效键从 `profiles`/`apiKeys`
    剔除——顺带清掉明文残留 Key；`routing` 中指向不存在 provider 的槽删除并写日志）→
    `Settings.tsx` 供应商按钮改两项（手机端有改动要出新 APK；旧 APK 点「智谱 GLM」只会 toast
    「切换失败」，属可接受的一次性过渡）→ 文档同步。GLM 仍可经 custom 接入（填地址、手填模型名）。
- ③ 长期记忆——**阶段一「堵漏」已合并并上线**（合并提交 `0d80373`，分支上 11 个提交，随 APK
  **v4.9.0-202611270122** 出包，电脑端 4.9.0 已部署；worktree memory1 已移除、本地分支已删；
  `npm run verify` 21 套全过）。落地内容：合并式前情梗概（`director/storyRecap.ts`；`memories` 加
  `kind` / `last_chapter_id`，`SCHEMA_VERSION` 1→2）；导演与写手共用写作简报（`buildStoryBrief`）+ 文风范例
  进写手提示；聊天先查再答、长期偏好与终局方向落库为钉选卡；`callJson` 重试保留原消息；改稿后重写
  纪要并重并梗概；沉淀须附原句（`agent/evidence.ts`）；思考模式回传 `reasoning_content`（真实 DeepSeek
  探测通过）；新增 `scripts/smoke-memory.mjs`。
  实施中的八项口径裁决（均接受）：①落后于章也后台补建梗概 ②合并失败冷却 60 秒 ③证据 ≥6 字、引号
  变体与首尾省略号视为相同 ④证据章默认最新一章 ⑤没点名时补钉选人物再带前两位、相关卡按标题和标签
  匹配 ⑥任何改稿都刷新纪要 ⑦聊天历史仍取末 12 条 ⑧改祖先线共享章只更新该线梗概。
  **阶段二、三未开工**（设计见下）。
  目标：风格统一 + 逻辑一致；
  缓解 DeepSeek 的幻觉与遗忘。
- ③ 调查结论（已核实代码）：
  - 滚动记忆有缺陷：`compactMemories`（`src/main/director/steps.ts:177-199`）章数 ≤12 不压，之后每入书一章
    多一个单章块，且提示词要「400-800 字」把纪要扩写；读取时整段 `clip(…,6000)` 保头去尾
    （`director/context.ts:92-96`）→ 20 余章后最新内容先被截掉。
  - 导演与写手是两个上下文：写手 `draftPrompt`（`steps.ts:40-66`）拿不到人物人设 `characters.data`、
    非钉选卡、`books.styleSample`；导演 `agentSystem`（`agent/loop.ts:344-374`）没有 `styleBlock` 与记忆，
    靠 `get_write_context` 拉；写章任务 `history: []`（`jobs.ts:342`）；提示里仍有「作者选定的走向」
    （走向卡已废除的过时措辞）。
  - 聊天（free）模式失忆：只取末 12 条 chat 消息（`jobs.ts:586-589`），系统提示不带记忆、不要求先查再答；
    作者偏好不强制落库；终局方向（skeleton）只回显未落库（`director/onboard.ts:247-256`）。
  - 沉淀与检索：`save_card` 丢 data/tags（`agent/tools.ts:817-826`）；`save_foreshadow` 不收
    plantedChapterId（`tools.ts:914-937`）；改稿不刷新 `chapters.summary`；删末章不回滚状态/伏笔/记忆
    （`store.ts:532-575`）；`search_project`（`tools.ts:679-718`）与 `searchSampleSections`
    （`store.ts:1184-1199`）都是子串首命中、无排序。
  - `callJson` 解析失败重试时把整段 user 换成「上次输出开头 200 字」（`director/callJson.ts:183-198`）→
    重试会凭空编。
  - 思考模式：assistant 历史不带 `reasoning_content`（`llmOpenai.ts:54-76`、`loop.ts:543-551`）。已用生产 Key
    实测：工具调用 id 为模型真实签发时续轮 200，只有伪造 id 才 400 → 线上不触发（生产 19 条 chat 全
    done），按文档加固即可。
- ③ 设计（三阶段，串行开线；每阶段一个 general 子代理；队列式冒烟桩同步改）：
  - 阶段一「堵漏」（分支 `feat/memory-stage1`）：①合并式前情梗概（固定结构：主线脉络/伏笔状态/人物关系/
    时间地点，上限约 1500 字；`memories` 加 `kind` legacy/running，`SCHEMA_VERSION` +1，旧块保留作首次
    合并输入、不再注入；`forkLine` 的 COPY_COLUMNS 同步）②导演与写手共用上下文构建（写手提示补出场
    人物的 data+state、相关设定卡、计划；导演系统提示加 `styleBlock` 与记忆简报；`books.styleSample`
    作 few-shot 放提示末尾；改掉「作者选定的走向」）③聊天模式带记忆简报 +「先查再答」；作者长期偏好
    存成钉选卡；终局方向落库 ④callJson 重试保留原消息（追加纠错说明，不替换）⑤改稿后刷新该章纪要
    ⑥沉淀带证据：save_card / save_foreshadow 必须附本章原句与章节号，服务端校验原句确在正文里
    ⑦思考模式回传 `reasoning_content`（记 AGENTS 踩坑 18）⑧新增/改名工具同步
    `mobile/src/pages/write/labels.ts`。
  - 阶段二「全书档案」：事件时间线表（章号、人物、地点）；人物「知道/不知道」知识边界；`search_project`
    升级 FTS5（`Intl.Segmenter` 分词 + BM25 + LIKE 兜底），命中带章号；写手动笔前自动检索「相关前情」。
  - 阶段三「巩固与风格」：每 8 章的后台审计升级为巩固任务（对照原文复核设定与状态、刷新梗概、提炼
    设定卡；不一致只作为建议报给作者，作者保留最终决定权）；风格一致性检查进审读。
  - 硬约束：已有数据不删（只增量迁移）；作者保留最终决定权；向量/图谱暂缓。决策记录见
    `docs/v2/DECISIONS.md` §14。
- v4.9.0 升级时生产库已自动留升级前快照 `backup-pre-migrate-20261127-012222.db`（`user_version` 1→2）；
  升级后核对通过：范文两本（254165 字/19 章、535677 字/67 章）、两本书各绑 2 本、章数 6 / 1 均未变。
- 待线上观察（v4.9.0 用一段时间再看）：合并梗概的实际质量与长度（目标 1500 字）；证据校验的真实退回率
  （写章任务里 `save_card` / `save_foreshadow` 被拒重提的次数）；聊天先查再答是否变慢；
  `reasoning_content` 回传（已用真实 DeepSeek 探测通过，线上再看 chat 任务有无 failed）。
- **进行中：嵌套分叉丢祖先章的修复线**（阶段一验收时读码发现的既有缺陷，与长期记忆无关）。
  现象：`effectiveChapters` 用分叉点的 `order_no` 去截祖先线的有效章列表，而各线章序号从 1 重排、跨线不可比
  （`store.ts` ~:502）。复现：主线 10 章 → B 分叉于第 6 章后、B 写 2 章 → C 分叉于 B 第 2 章后 →
  `effectiveChapters(C)` 只剩 A1、A2、B1、B2（丢 A3–A6）。生产两本书都只有主线，现有数据不受影响。
  开发线：分支 `fix/fork-tree`（基于 0d80373），worktree
  `C:\Users\14270\.local\share\opencode\worktree\754ca1\forktree`，子代理 session `ses_de71f8050fferb9m7a35XStF36`。
  两个提交：①`fix(store)` 按分叉点章在其所属线有效章列表里的位置取前缀（分叉点章已删的兜底只比直接
  父线自己的章、继承的祖先章全保留；不改表结构；扩 `smoke-fork.mjs`；同步 AGENTS.md「分叉树」）
  ②`fix(memory)` 改到子线也继承的章时，安排子线的前情梗概重建（删 `running` 行，交给已有补建机制懒
  重建；`legacy` 不动；扩 `smoke-memory.mjs`）。
- ④ **新需求：写作链路简化——只保留一个主智能体，写正文改由主智能体派「写作子智能体」**（2026-11-27 08:00，
  用户原话：「导演和写手原来是两套机制吗？需要简化一下，把智能体里不需要的写手给去掉，只保留一个，
  改为可以调用子智能体，由主智能体决定给子智能体提供什么」）。状态：**设计已定（只读摸底完成），未开工**。
  现状事实（已读码）：写手不是智能体，是被拦截的工具 `write_chapter_draft`（`agent/loop.ts:210` 定义、:697
  拦截）里由代码拼 `draftPrompt`（`director/steps.ts:51`）再调 `genDraft` → `writeSegments`（S:100）的一次性
  调用，草稿全文回灌给导演（L:745-753）；`revise_chapter`（L:803）= `genRevisePlan`（S:273）出 find/replace
  计划再 `applyRevisePlan`（S:249）；已有的 `spawn_subagent`（L:850）只是只读调查员（`subTools()` L:439、
  `SUB_SYSTEM` L:411、12 轮、`say: () => {}` 对作者不可见）。
  顺序：排在嵌套分叉修复合并并部署之后开线；长期记忆阶段二排在其后（三者都改 loop.ts / steps.ts / jobs.ts，
  必须串行）。分支 `feat/single-agent`，worktree + general 子代理。缩写：L=`agent/loop.ts`，J=`jobs.ts`，
  S=`director/steps.ts`，X=`director/context.ts`，T=`agent/tools.ts`，M=`smoke-m3-stub.mjs`；行号基于 81208ad。
  实施规格：
  1. 派写手：`write_chapter_draft` 入参改为主智能体自己写的任务简报（本章要发生什么、出场人物与要点、要埋 / 收的
     伏笔、基调与节奏、目标字数，可附想模仿的句子与要避免的），不再要求 title / synopsis / beats / scenes；
     L:379-380「一次成型…再 draft 一次」与 L:389 相应改写。
  2. 写作子智能体：把 `spawn_subagent` 扩成「派子智能体」（任务类型 research = 现状调查员 / write = 写手）。
     write 的 system = 写手角色纪律 + 电脑端自动附上的硬约束（书信息、红线、正负词、文风、文风范例
     `books.styleSample`、目标字数）+ 记忆简报（`buildStoryBrief` X:118，focus = 简报文本）+ 任务简报；
     模型走 writer 槽（`resolveAuth`，config.ts:222）；工具 = 读工具（L:425 的 11 个，另加 `get_character`、
     `get_card`）+ `submit_draft`；`maxTurns` 12。
  3. 交稿：`submit_draft` 为子循环内的拦截工具，分段提交（每段约 1500 字以内），服务端拼成 `lastDraft.content`；
     `job:progress`（L:905 → J:229）照常报字数并喂狗。正文不进聊天流（现行口径不变，手机上只有字数进度与
     入书卡）。
  4. 自检与回改：服务端 `selfCheck`（S:158 = lintChapter）；有 major 就把问题当工具结果退回**同一个**子智能体
     让它重新 `submit_draft`（最多 2 轮，取代 `autoFixDraft` S:172 的一次性重写）；仍 major 则按现行规则带着
     报告入书。冒烟靠 negativeWords 设「忽然」触发的「自动修一轮」相应改成「被退回一次」。
  5. 回灌瘦身：回给主智能体的工具结果只有标题、字数、自检报告（去掉 L:745-753 的「正文全文：」）；
     `lastDraft` 仍存全文供 `commit_chapter`（L:756）用。
  6. 改稿：`revise_chapter` 带 `segment` = 局部修改，主智能体读原文后直接给「原文 → 改后」对（去掉
     `genRevisePlan` 这一层，全未命中仍报「改稿未命中原文」）；整章重写 = 派写作子智能体（任务简报 = 修改
     要求，交稿后走同一条替换与 `noteRevisedChapter`）。`job:startRevise`（J:433）无人值守链路保留
     `genRevisePlan` 作兜底。
  7. 范文：`genStyleRefs`（L:305）的字面检索注入保留一段作起点；写作子智能体可自己 `read_sample`（简报里可
     点名参考哪本范文的哪段）。
  8. 手机端：父工具卡显示任务简报摘要（「派写手：……」）；子智能体的查询轮落成 activity 卡（不再
     `say: () => {}`）；新 / 改名工具同步 `mobile/src/pages/write/labels.ts` 的 `TOOL_LABEL`；不新增确认步骤。
  9. 不动：审读 / 审计 / 诊断 / 记忆整理等后台检查（S:341 / 368 / 402）；聊天模式无写章权限；计划模式闸门
     （J:269 / 285）；工具结果 30000 字上限（DECISIONS G8）。
  10. 冒烟：写章队列（M:381，9 项）整体重排——多出子智能体的读工具轮、`submit_draft` 轮与回改轮；断言工具卡
     序列与写手提示的地方同步改（m6:148、m6:163；`smoke-memory.mjs:357` 直调 `draftPrompt`）；桩按 system
     身份行区分主 / 子（旁路识别在 M:529）。
  已知代价：每章多几次模型调用、耗时多几十秒；简报写得薄时靠记忆简报与读工具兜底（提示词要求简报必含
  出场人物 / 伏笔 / 目标 / 基调 / 字数）。
- **2026-11-27 进度**：分叉修复已合并并部署到生产电脑端（`0761189`，指纹 `c893536c6bb3c8e4`；未改手机端，不出 APK，APK 更新源仍为 v4.9.0-202611270122 / vc 29928562）。④ 开发线已建：worktree `C:\Users\14270\.local\share\opencode\worktree\754ca1\single`、分支 `feat/single-agent`（基于 0761189，工作区干净、`npm ci` 已装、**零提交**）。实施子代理因「每周/每月使用上限」中断（额度 **2026-12-01 15:39:11** 重置，此前不要再派子代理）→ 由主会话直接实施，或等额度恢复后派子代理。
- **实施细化（派单时定的协议，照此实现；行号基于 0761189，L=`agent/loop.ts`、S=`director/steps.ts`、J=`jobs.ts`、M=`smoke-m3-stub.mjs`）**：
  1. 内部统一函数 `runSubagent({kind:'research'|'write', …})`；`spawn_subagent`（调查员，行为不变）与 `write_chapter_draft`（派写手）都走它；嵌套循环透传父循环的 `onTurn` 喂狗。
  2. `write_chapter_draft` 新入参 `{ brief: string（必填 60–4000 字，过短返回 ok:false 让主智能体重提）, title?: string, targetWords?: number }`；不再要 title / synopsis / beats / scenes。
  3. 写作子智能体：system = 写手角色纪律 + 服务端自动附上的硬约束（书信息 / 红线 / 正负词 / 文风 / 文风范例 / 目标字数）+ `buildStoryBrief(book, lineId, {text: brief, plan: chapterPlan})` + `genStyleRefs` 一段范文起点（稳定内容在前、动态在后），含唯一身份行「你是写作子智能体」；首条 user = 任务简报 + `chapterDirection`（作者补充方向 ≤300 字）+ 交稿规则；模型走 writer 槽；thinking 关；每轮 maxTokens 8000；maxTurns 12；对作者不可见（`say: () => {}`，手机端展示是第二步）。
  4. 写作子智能体的工具 = 13 个读工具（L:425 的 11 个 + `get_character` + `get_card`）+ 三个拦截工具：`submit_draft({text?, done?})`（追加一段，每段 ≲1500 字；每次按累计字数发 `job:progress`；`done` 时对累计全文跑 lintChapter，有 major 且退回 <2 次 → ok:false 附问题与含负向词的原句让它改；通过 → 回「已收稿，请调用 finish 提交回执」）、`revise_draft({find, replace})`（对累计草稿字面量精确替换，未命中 ok:false）、`finish({summary, characters?, foreshadows?, settings?})`（结构化回执，各项带 evidence 原句；用 `agent/evidence.ts` 同一归一化规则校验原句确在草稿里，不对的丢掉并标出；到 maxTurns 仍没 finish → 用已收稿内容 + 空 summary 继续）。
  5. 回给主智能体的 data = `{title, words, summary, report, characters, foreshadows, settings, head(前300字), tail(后300字)}`，**不含全文**；`lastDraft` 仍存全文供 `commit_chapter`；新增只读拦截工具 `read_last_draft`（默认 2000 字、上限 8000）；删 `draftPrompt` / `genDraft` / `autoFixDraft` / `DraftInput` / `writeSegments`；`commit_chapter` 的 `summary` 改为可选，缺省用回执 summary。
  6. `revise_chapter`：`edits:[{find,replace}]` = 主智能体先 `read_chapter` 再直接给「原文 → 改后」；`brief` = 整章重写（派写作子智能体）；只给 `instruction` = 兜底走 `genRevisePlan`（保留不删）；全未命中仍报「改稿未命中原文」；成功后照旧 `noteRevisedChapter`；`job:startRevise` 无人值守链路不变。
  7. 提示词改写位置：L:210（write_chapter_draft 描述）、L:241 / L:284 / L:379–380（「一次成型…再 draft 一次」→ 写手自检不过会被退回自己改，只在需要整章重来时再派一次）、L:389（free 模式纪律）、L:745–753（去掉「正文全文：」回灌）、S:79–92（删写手提示）、S:336（「与写手隔离视角」→ 审读与写作视角隔离）、`storyRecap.ts`:314、J:336；主智能体新纪律：写任务简报 → 调 write_chapter_draft → 用回执里的纪要与原句 commit_chapter → 沉淀（evidence 用回执原句）→ finish。
  8. 桩与冒烟：M 按 system 身份行把写作子智能体 / 调查员的调用路由到独立队列（不吃主队列，参照 M:529 的旁路）；主队列去掉 DRAFT / DRAFT_FIXED；新增 `scripts/smoke-writer-subagent.mjs`（简报过短被拒、分段累计、自检退回→revise_draft→通过、超轮带报告入书、回执证据校验、回执不含全文、edits 直改、brief 整章重写、startRevise 兜底）；同步 m2 / m4 / m6（m6:148 写手提示断言、m6:163 工具卡序列）、plan、`smoke-memory.mjs`:357（直调 draftPrompt）→ 预期 **22 套**。
  9. 分两步：A = 主进程 + 桩 + 冒烟 + AGENTS.md / DECISIONS §15 对齐 + `mobile/src/pages/write/labels.ts` 的 TOOL_LABEL；B = 手机端（父工具卡显示任务简报摘要 + 实时「写手已写 N 字」——`job:progress`→`tickerStore.progress` 现无读取方；子智能体工具调用落 activity 卡、白话不进时间轴）+ 行为验证 + 截图。
  10. 合并后、部署前：用真实 DeepSeek 在临时数据目录试写一章（只读取生产 settings.json 的密钥、不打印），验证新提示词下的真实工具调用链。
- **不变项**：不新增确认步骤；计划模式闸门 / 聊天无写章权限 / 审读审计诊断记忆整理照旧；正文不进聊天流；不迁移不删数据；作者保留最终决定权。
- **接手须知**：开发线里绝不 deploy / apk、不碰 3910 与生产数据目录；提交按五步：`refactor(agent): 子智能体运行器——调查与写作共用一套嵌套循环` → `feat(agent): 写手子智能体——任务简报、分段交稿、自检回改与结构化回执` → `refactor(agent): 改稿去掉计划层——局部修改直接给原文与改后，整章重写派写手` → `test(smoke): 桩按身份行路由子智能体调用，写章队列重排；新增 smoke-writer-subagent` → `docs(agent): 写作链路简化落地——项目须知与决策记录对齐实现`；验证 = 门禁 + `rm -rf dist && npm test`（22 套）+ 前端构建与 Tailwind 哨兵；每步可独立编译并 push（`git push -u origin feat/single-agent`，GitHub 慢就循环重试）；做完 A 再做 B；合并回主 checkout（`git merge --no-ff feat/single-agent`）→ `npm run verify` → 真实模型试写一章 → `npm run apk`（自动 deploy）→ push 分支与 tag。
- 下一步：等修复线子代理完成 → 验收（两个提交、`npm test` 21 套、与 origin 同步）→ 主 checkout
  `git merge --no-ff fix/fork-tree` → `npm run verify` → push → `worktree_remove` forktree →
  `git branch -d fix/fork-tree` → `npm run deploy`（本修复不动手机端，按 AGENTS 约定不出 APK；
  版本号与 tag 留到下次出包时一并推进）。
  随后开线实施 ④（规格见上）：`worktree_create` → `git switch -c feat/single-agent && git reset --hard feat/v2-rebuild`
  + `npm ci` → general 子代理；合并后出包。
  若本文件停在这里，新会话从这里接着做：②③ 已上线不要重做，④ 设计已定、待修复线合并后开线；修复线若因子代理额度中断，先核 forktree
  worktree 的磁盘现状（`git status -sb` / `git log --oneline`）再续做。

### APK 自更新故障修复（已完成，v4.8.1）

- 现象：应用内提示「新版 4.8.0 已下载」，点安装却装到 4.3.0 旧包 → `安装失败(-25) 无法降级安装`。
- 根因：Capacitor `PluginCall.getLong(name, default)` 只在值是 `Long` 时返回，否则给默认值；
  JS 传来的 `versionCode` 经 JSON 到原生是 `Integer` → 永远读成 0 → 旧插件落到固定文件名
  `cacheDir/NovelMaker.apk`（4.2.0 版时下载的 4.3.0 包）→ `status` 报它「已下载」、`install` 装的也是它。
- 修复：`0b1da5b`（原生改用 `getData().opt` 自己转数值、去掉固定文件名回退、下载写 `.part` 并核对
  字节数与包内真实 versionCode 后才转正、安装前再核一次；JS 就绪判据改 `complete`、下载 URL 带 `?vc=`）
  + `9615fdd`（`versionCodeOf` 改用 int 形式——当前安卓编译环境解析不到 `longVersionCode`，原因未查明）。
  详见 AGENTS.md 踩坑 17。
- 上线：APK **v4.8.1-202611270010**（versionCode 29928490），release 提交 `09b276a`，tag v4.8.1。
- 遗留（用户侧）：手机上的 4.7.0 自带缺陷，服务端救不了——这一次要用浏览器打开
  `http://100.100.62.8:3910/api/mobile/apk?vc=29928490` 装（或清除 APP 缓存后走应用内更新）；
  装上 4.8.1 之后应用内更新才可靠。

---

> **用途**：长任务的执行状态外置。会话被中断/达到限制后，任何新会话读此文件即可无损续做。
> **纪律**（写入 AGENTS.md 的约定）：
> 1. 长任务（多文件/多轮）**动手前**先把计划写到这里，再开工；
> 2. 每完成一步就更新勾选与「下一步」，不等任务全做完才写；
> 3. 新会话开始时若本文件有未完成任务，**先续做它**，不接新需求；
> 4. 任务完成（commit+push+部署）后清空回本模板。

---

## 当前状态：进行中（2026-11-27）

- 自主优化长跑（需求包 A–E、全新克隆自检 Q、部署漏洞修复）与「首页重设计 + 底部导航 + 范文功能重做」
  均已合并、push、部署、出包；APK 自更新故障已修（v4.8.1）。
- 用户指令 ②移除 GLM、③长期记忆阶段一 **已上线 v4.9.0**；③ 阶段二、三未开工（设计已定，见顶部）。
- **进行中**：嵌套分叉丢祖先章的修复线（见顶部「下一步」），新会话先续做它，不接新需求。
- 生产现状：电脑端 4.9.0 / `build.sourceHash=7473120975aea4bc`（PID 不固定，需要时查 health）；
  手机端更新源 APK **v4.9.0-202611270122**（versionCode 29928562）。用户若仍停在 4.7.0，这一次需用
  浏览器打开 `http://100.100.62.8:3910/api/mobile/apk?vc=29928562` 安装；已装 4.8.1 的可在应用内
  「设置 → APP 更新」。
- 「候选清单」里的项均未排期，要做先逐项重新核实证据。

## 授权与规则

- 2026-11-25 用户授权：「检查该项目并进行你觉得值得的优化，自己提需求自己改不要停」+
  「记得按你觉得值得的需求进行 git 管理」。该长跑已收线（见「已完成需求包」），现等用户新需求。
- 开发线纪律（lane-flow）：每个需求包 = 一个独立开发线：
  `worktree_create` → `session_move` → 从 `feat/v2-rebuild` 开 `feat/<名>`/`fix/<名>` → `npm ci`
  → 开发 → 门禁（typecheck+biome）+冒烟 → commit+push → 回**主 checkout**（本目录）
  `git merge --no-ff` → push → `worktree_remove` → **在主 checkout** 跑 `npm run deploy`（主进程有改动）
  / `npm run apk`（前端有改动）
- 单点小修（文档、一行改动）不开线，直接在主 checkout 提交。

## 主 checkout 关键事实

- 主目录：`C:\Users\14270\.local\share\opencode\worktree\754ca1\v2-rebuild`（分支 feat/v2-rebuild）
- **生产 server 跑的就是主 checkout 的 `dist/main/index.js`**（deploy.mjs `cwd: root`）——
  **开发线里绝不 deploy / 绝不 build-apk**（会让生产寄生在待删的 worktree 上、且会打 tag 推版本）；
  开发线只靠冒烟脚本验证主进程改动。合并回主 checkout 后再 deploy。
- `npm run apk` = `build-apk.mjs`（v4.5 起两阶段）：先 `deploy.mjs --if-stale` 确保生产 server
  是当前源码的构建 → 出包 → **全部成功才**提交 `chore(release): vX` + 打 tag（失败回滚版本号）。
- 冒烟回归全集：`npm test`（=build+`scripts/smoke-all.mjs`，21 套串行）；`npm run verify`
  = typecheck+lint+test，即完整门禁。输出很长——后台跑+重定向到文件+只看尾部。
- 2026-11-27 基线：HEAD=dec5f7a（`chore(release): v4.9.0`，tag v4.9.0 已推送），与 origin 同步；
  生产 health `build.commit=dec5f7a`、`build.sourceHash=7473120975aea4bc`；
  手机端更新源 APK v4.9.0-202611270122（versionCode 29928562；含移除 GLM + 长期记忆阶段一；
  此前的 v4.8.0 含首页重设计 + 底部导航 + 范文功能重做）。`SCHEMA_VERSION` 现为 2。
- **判断生产是否落后：比对 `/api/health` 的 `build.sourceHash` 与
  `node scripts/build-info.mjs --print`**（`npm run apk` 会自动 deploy，有任务在跑时拒绝重启）。
- **在主 checkout 跑过 `npm test` / `npm run verify` 之后要记得部署**：两者都会重新 build、改写
  `dist/`，而生产进程仍是旧的那一个（7824e33 起 health 如实上报本进程加载的构建，
  `deploy --if-stale` 不会再被骗过）。
- **只改主进程的提交不出 APK**（内容相同的包只会白白打断用户安装）；手机端有改动才 `npm run apk`。
- 拆提交后逐个中间提交验门禁的手法：`git worktree add --detach <tmp> <sha>` + `npm ci` + tsc 两套
  + biome；按依赖顺序提交（库层 → 调用层），强耦合的重构（如 jobs.ts+store.ts+loop.ts）合成一个提交。
- 上下文纪律：大文件分段读、读完即压缩；冒烟输出绝不直接进上下文。

## 开线坑（2026-11-25 实锤）

- `worktree_create` 默认从 **main（v1）** 拉新 worktree，不是 feat/v2-rebuild！开线后必须
  `git switch -c <branch> && git reset --hard feat/v2-rebuild`（或先 reset 再开分支）。
- 新 worktree 无 node_modules，`npm ci` 很快（2026-11-25 实测约 6s）；mobile-app/node_modules 仅 build-apk 需要。

## 已完成需求包（均已合并进 feat/v2-rebuild 并 push）

- **A 工程卫生 + 部署门禁 `chore/hygiene`**（2026-11-25，合并 65df5f2，APK v4.5.0，release 0b6395d）：
  清死代码与死依赖；biome 纳管 mobile+scripts（BottomSheet 统一弹层）；`npm test` 冒烟总入口；
  构建指纹进 health + deploy 加固。提交：b027707 / 45d0e93 / aee1226 / 22016f8 / 862051e / 926ce9d。
- **B 后端 P1 `fix/job-lifecycle`**（2026-11-25，合并 09db98f；无手机端改动，未出 APK）：LLM 重试
  读结构化状态码（429/5xx、retry-after、流中断或挂起 120s）；启动接口入队即返回、可真正取消、
  队列先来后到、重启续跑、终态不被覆盖；局部替换按字面量；`scripts/smoke-jobs.mjs`。
  提交：a4582d3 / 43b978c / 1b3ac5f / e876dbe。
- **C 数据安全 `feat/data-safety`**（2026-11-25，合并 b8806c7，APK v4.6.0-202611251900，release fbdbe4b）：
  范文摘要不读全文；`save_character` 不覆盖活状态；开书确认先问后存；分叉点保护（起点章不可删、
  `lines.fork_order`）；settings.json 原子写；每日备份 + 保留策略 + 手机端备份与恢复。
  提交：9186eba / 7c336c9 / 95835de / f3d6e26 / 33971d9 / e2306cf。
- **D 手机端打磨 `feat/mobile-polish` + 支线 `fix/mobile-input`**（2026-11-26，合并 6ffb2da + 7135079，
  随 APK v4.7.0 发布，release 342d057）。提交索引：
  - 第 1 组 写作时间轴：9412257 全局轻提示；e187922 失败卡可重试、计划卡不再闪「已处理」；
    104a1da 较早的节点卡不再退化成白话气泡（新增通道 `job:listBriefs`，最近 300 个任务、不带正文）；
    d52132c 聊天流校正不再每个增量拉一次、过期增量丢弃
  - 第 2 组 fix(ui)：52b92f0 弹层支持返回键关闭；8b914a1 连不上电脑端时明确提示与重试
    （`components/ErrorBox.tsx`）；cd3425d 操作失败弹出提示、不再静默
  - 第 3 组 feat(shelf)：9311328 切子页滚动回顶；e04f732 钉选与删除失败弹提示；9ca1e93 整章改稿前先确认；
    5d4c2a2 + 7fa4f44 断网但有旧数据时书架横幅、恢复后自动消失；e47987c 中途退出的草稿书可继续开书；
    e5ae811 点击区域 ≥40px
  - 第 4+6 组 阅读页与主题：dff9072 离开阅读页恢复系统栏；a0b7e53 切章单请求、失败可重试；
    99c57a6 阅读页按钮 ≥40px；93c74f7 范文全屏阅读器返回键关闭；b32a417 深色主题残留的对比度；
    e76dd92 探测中显示「正在连接…」；2809995 夜间模式覆盖顶栏、目录、字号面板
  - 支线 fix/mobile-input：2f0db74 输入框随内容增高、键盘弹出贴底；6406b18 工具卡补全中文名（36 个工具）；
    68c37ac 清理死代码；8fd4ca7 模型与服务端错误翻译成作者看得懂的提示
- **E 项目须知重写 `docs/agents-v2`**（2026-11-25，合并 c6aaa80）：AGENTS.md 257→128 行（只写 v2 现在
  仍成立的事实；线 Q 补缺后现为 136 行）；`docs/v2/HISTORY.md`（演进史）；`docs/v1/LEGACY.md`（v1 归档）。
- **Q 全新克隆自检**（2026-11-26，合并 5b6091a + 93b40cb）：从零 `npm ci` → `npm run verify` 全过 →
  按文档起服务一次成功。发现项已全部处理：
  - 21c889b + e313b34 + fa43661（合并 5b6091a）：冒烟临时目录泄漏 + 文档缺口——冒烟统一收尾
    （`scripts/temp-dir.mjs`），总入口每套跑前跑后比对 Temp 下 `nm-*` 目录；AGENTS.md 补 `npm run start`、
    停止服务、出包前要装 `mobile-app` 依赖；README 修正过时说法。本机积压的 7353 个 `nm-*`
    临时目录已清（释放约 1.6 GB）
  - 小尾巴（合并 93b40cb）：e90feb9 兜底话术不再提已废除的走向卡；93bf982 `docs/v2/DECISIONS.md`
    新增 §11（补记走向卡废除等交付期决策变更）；9ff2e08 README 与 AGENTS 的安装命令、模块清单对齐；
    4f1a58e `deploy.mjs` 失败退出前留出收尾时间
  - 另有 55789df（主分支直接提交）自由模式提示不再让作者去点已删除的按钮
- **部署漏洞修复**（2026-11-26，7824e33，仅电脑端）：服务进程原先每次请求都重新读
  `dist/build-info.json`，在同一目录跑过测试后旧进程会谎报新构建，`deploy --if-stale` 因此被跳过
  → 手机端新、电脑端旧。现在以启动时加载的那一份为准（文件指纹一致才用文件），如实上报；
  新增 `smoke-build-info.mjs`，`smoke-deploy.mjs` 按真实语义改写（冒烟 17 → 18 套）。

- **F 首页重设计 + 底部导航 + 范文功能重做 `feat/home-nav`**（2026-11-26，合并 73304db，
  随 APK v4.8.0 发布，release 0eaefde）。开发线 12 个提交：
  - 导航与首页：d8f5a96 DECISIONS §12；89d5169 底部导航三项「写书 / 范文 / 设置」（书内不显示，
    设置与范文页按返回键回写书）；591fd65 范文从设置迁为独立页；1edc859 写书页重设计（顶栏「共 N 本」+
    「＋ 开新书」→「最近在写」主卡 →「我的书」两列色块封面 →「开书中」→ 已归档入口 → 空状态）；
    1402118 / afd596a / 5c7006d 展示打磨
  - 范文导入：8c4e98e 手机端直接选 txt 导入——分片上传四通道（`sample:uploadBegin/Chunk/Finish/Abort`），
    主进程解码链 BOM → UTF-8 严格 → GB18030；重名另存「名（2）」；1.5MB / 600 章实测约 10s；
    `imports\` 文件夹老路保留。迁移只加列（`SCHEMA_VERSION` +1，升级前自动快照），已有范文与绑定不动
  - 阅读层：78cb95e 目录（含「开头」）/ 关键词搜索并高亮命中 / 本机进度记忆（`nm-sample-reader`）/
    字号 13–26 / 章内前后翻 / 返回键先关面板再退；目录底部「给哪些书用」直接勾选绑定（归档与开书中不参与）
  - 收尾：faccda1 新增 `scripts/smoke-sample-upload.mjs`（编码、重名、大文本、老库迁移不丢数据，冒烟 18 → 19 套）；
    c3a44dd 文案统一（界面不再叫「范文库」「书架」）；bc08ade DECISIONS §13；c725913 绑定后书目按书名排序不再跳序

## 待用户真机验收（自动化测不了）

- 返回键关闭弹层
- 输入框随内容增高；软键盘弹出后贴底
- 夜间模式（顶栏 / 目录 / 字号面板）
- 断网时写书页顶部的提示横幅
- 范文页点「导入 txt」选一个手机里的 txt：文件选择器能打开、导入成功并显示字数章数
- 阅读层的实体返回键：面板打开时先关面板，再退回范文页
- 大文件（几 MB 的 txt）导入耗时与成功与否

## 候选清单（未做，动手前先逐项重新核实证据）

- `chapter_versions` 是死表（只有建表与删除、从不写入）
- `JobKind` 含 `'rewrite'` 但没有对应 runner
- 语义检索（`docs/v2/DECISIONS.md` G10）未做，代码里是 SQL 关键词检索
- 两个旧命名的快照文件（如 `backup-del-char-20261106.db`）不匹配清理正则，永不被清理（无害）
- `lib/tickerStore.ts` 的 acts / progress 是只写状态（App.tsx 的 SSE 接线仍写入，全仓无读取方）
- 手机端 WebView 对 POST 复用死连接的行为未验证（服务重启后首个请求可能落空）
- `docs/v2/DECISIONS.md` 两处与现行不一致：§7 导出 vs `4494bc2`、D4 vs `f011c1a`；
  计划模式、M7 全对话化、G3–G5 的决策未补记
- 托盘（systray）每次启动在 Temp 留约 14 个 `systray_temp_icon*` 文件（本机已 570 个）
- 旧板遗留、未排期：生产产物迁出 worktree（现寄生在 opencode worktree 路径）；supervisor 守护
- 旧板线索、未核实：server.log 出现过 2 次 `[llm] tool save_character 参数 JSON 解析失败…已丢弃片段`，
  该日志行仍在 `llmOpenai.ts`，是否复现未查

## 明确不做

- 聊天时间轴「加载更早」（消息上限 200 条，约对应 60–100 章）
- 调研后决定不改：`purgeDraftBooks` 不加快照（草稿书按定义无用户发言）；子线删不到父线章（已有校验，非问题）
