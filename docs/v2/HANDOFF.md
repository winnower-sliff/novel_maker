# 任务交接板

## 当前状态：空闲（2026-11-27）

- 自主优化长跑（需求包 A–E、全新克隆自检 Q、部署漏洞修复、首页重设计 + 底部导航 + 范文功能重做）与
  11-27 的四件事（移除 GLM、长期记忆阶段一、嵌套分叉修复、写作链路简化）**全部收线**：已合并、push、
  部署、出包。现等用户新需求；「候选清单」均未排期，做之前先逐项重新核实证据。
- 生产现状（2026-11-27 核对）：电脑端 `/api/health` 自报 version 4.10.0 / `build.commit=995d27c`
  （`chore(release): v4.10.0`）/ `build.sourceHash=bb7f36c2f21ac331`（PID 会变，不要写死，需要时查 health）；
  APK 更新源 **v4.10.0-202611272003**（versionCode 29929683，4325511 字节）；tag v4.10.0 已推送；
  冒烟 22 套；`SCHEMA_VERSION` 2。用户若仍停在 4.7.0，需用浏览器打开
  `http://100.100.62.8:3910/api/mobile/apk?vc=29929683` 安装（见「待用户真机验收」）。
- 发布提交链（新→旧，其上只有文档提交）：`995d27c`（release v4.10.0）← `04ef40f`（写作链路合并，
  分支上 `99dc358`…`36ec103`）← `129cbe0` ← `0761189`（分叉修复合并）← `71c5787` ←
  `dec5f7a`（release v4.9.0）← `0d80373`（长期记忆阶段一合并）← `7510691` ← `1b1e9c1`（移除 GLM 合并）。

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
- 冒烟回归全集：`npm test`（=build+`scripts/smoke-all.mjs`，22 套串行）；`npm run verify`
  = typecheck+lint+test，即完整门禁。输出很长——后台跑+重定向到文件+只看尾部。
- 2026-11-27 基线：最近一次发布提交 `995d27c`（`chore(release): v4.10.0`，tag v4.10.0 已推送），
  与 origin 同步；生产 health `build.commit=995d27c`、`build.sourceHash=bb7f36c2f21ac331`，
  与 `node scripts/build-info.mjs --print` 一致（生产不落后）；
  手机端更新源 APK v4.10.0-202611272003（versionCode 29929683；含移除 GLM + 长期记忆阶段一 +
  写作链路简化；此前的 v4.8.0 含首页重设计 + 底部导航 + 范文功能重做）。`SCHEMA_VERSION` 现为 2。
- **判断生产是否落后：比对 `/api/health` 的 `build.sourceHash` 与
  `node scripts/build-info.mjs --print`**（`npm run apk` 会自动 deploy，有任务在跑时拒绝重启）。
- **在主 checkout 跑过 `npm test` / `npm run verify` 之后要记得部署**：两者都会重新 build、改写
  `dist/`，而生产进程仍是旧的那一个（7824e33 起 health 如实上报本进程加载的构建，
  `deploy --if-stale` 不会再被骗过）。
- **只改主进程的提交不出 APK**（内容相同的包只会白白打断用户安装）；手机端有改动才 `npm run apk`。
- LLM 桩按 system 身份行把写作子智能体 / 调查员的调用路由到**独立队列**（`WRITER_QUEUE` /
  `RESEARCH_QUEUE`，不吃主队列）——改 prompt 步数或增减工具调用轮都要同步改队列；
  详见 AGENTS.md「冒烟」一节。
- 拆提交后逐个中间提交验门禁的手法：`git worktree add --detach <tmp> <sha>` + `npm ci` + tsc 两套
  + biome；按依赖顺序提交（库层 → 调用层），强耦合的重构（如 jobs.ts+store.ts+loop.ts）合成一个提交。
- 子代理会撞「5 小时 / 每周每月使用上限」与偶发网络错误：额度问题等重置后用**同一 sessionID** 发
  follow-up 续做，网络错误直接 follow-up 重试；两者都先核磁盘现状（`git status -sb` /
  `git log --oneline`），不重做。
- 分支现状（2026-11-27 核对）：开发线 worktree 已全部移除（`git worktree list` 只剩本目录与
  `E:\MyProject\novel_maker` 的 main）；远端已合并的旧分支删了 11 条，**但 `feat/single-agent`
  （`99dc358`，已并入 `04ef40f`）仍在远端**；本地另有 4 条已合并的旧分支未删：`chore/hygiene`、
  `feat/agent-harness`、`fix/job-lifecycle`、`refactor/global`。都是收尾小尾巴，确认后
  `git push origin --delete feat/single-agent`、`git branch -d <名>`。
- 上下文纪律：大文件分段读、读完即压缩；冒烟输出绝不直接进上下文。

## 开线坑（2026-11-25 实锤）

- `worktree_create` 默认从 **main（v1）** 拉新 worktree，不是 feat/v2-rebuild！开线后必须
  `git switch -c <branch> && git reset --hard feat/v2-rebuild`（或先 reset 再开分支）。
- 新 worktree 无 node_modules，`npm ci` 很快（2026-11-25 实测约 6s）；mobile-app/node_modules 仅 build-apk 需要。

## 已完成需求包（均已合并进 feat/v2-rebuild 并 push）

### 2026-11-27 这一轮（此前「进行中」里的四件事，全部收线）

- **移除 GLM**（合并 `1b1e9c1`，随 APK v4.9.0 上线；决策记录 DECISIONS A7-R）。四个提交：
  `37db83b` fix(config) 加载时清洗旧配置（`config.ts` 的 `sanitize()`：仅内存、不改名、不落盘）/
  `07b109a` refactor(provider) 删 GLM 预设、默认 DeepSeek、设置页只剩「DeepSeek / 自定义」/
  `5a12eba` test(config) 新增 `scripts/smoke-config.mjs` / `644abd0` docs。
- **长期记忆阶段一「堵漏」**（合并 `0d80373`，随 APK v4.9.0 上线；DECISIONS §14）。11 个提交：
  `c373653` callJson 重试保留原消息 / `a451ace` assistant 历史回传 reasoning_content /
  `3940fc2` 合并式前情梗概（`director/storyRecap.ts`）+ 新增 `scripts/smoke-memory.mjs`（端口 3980）/
  `e6cc2eb` `buildStoryBrief` 共用写作简报、文风范例进写手提示 / `0fb5d40` 改稿后重写纪要并重并梗概 /
  `1df1bf6` 聊天先查再答、作者长期偏好存钉选卡、终局方向落库 / `b427667` 沉淀须附原句
  （`agent/evidence.ts` 服务端校验）/ `d176911` docs / `7175aa4`、`4d303d5`、`b5b683b` fix。
  迁移 SCHEMA_VERSION 1→2（`memories` 加 `kind`、`last_chapter_id`）。
  **阶段二（全书档案：事件时间线、人物知识边界、FTS5 检索）与阶段三（巩固任务、风格检查）未开工**，
  方案在 DECISIONS §14。
- **嵌套分叉丢祖先章修复**（合并 `0761189`；只部署到生产电脑端，未改手机端、不出 APK）：
  `06f2081` `effectiveChapters` 按分叉点在祖先线里的位置截取，嵌套分叉不再丢祖先章 /
  `60f8015` 改到子线也继承的章时安排子线前情梗概重建。
- **写作链路简化（单主智能体 + 写作子智能体）**（合并 `04ef40f`，随 APK v4.10.0 上线；DECISIONS §15）。
  - A 步（电脑端）：`36ec103` `runSubagent` 子智能体运行器（调查员与写手共用嵌套循环）/
    `7fd3326` 写手子智能体（`src/main/agent/writer.ts`：`write_chapter_draft` 收任务简报 60–4000 字、
    `submit_draft` 分段交稿、自检有 major 退回同一写手最多 2 次、`revise_draft`、`finish` 结构化回执带
    evidence 校验；回给主智能体不含全文；新增 `read_last_draft`）/ `d0fdd42` `revise_chapter` 三条路径
    （`edits` 直改 → `brief` 整章重写派写手 → 只给 `instruction` 兜底 `genRevisePlan`）/
    `69823d3` 桩按身份行路由（`WRITER_QUEUE` / `RESEARCH_QUEUE` 独立队列）+ 新增
    `scripts/smoke-writer-subagent.mjs`（自带桩端口 3976，66 项断言）/ `e1e2a6e` docs + TOOL_LABEL /
    `6f32d8b` 冒烟计时器清理。
  - B 步（手机端）：`57fb30b` `commit_chapter` 的 quickActions 放回 `properties`（自 b1b3a48 起写在
    properties 外、真实模型看不到、建议钮一直出不来）/ `aba319a` 写手每个工具调用落工具卡（带累计字数），
    派写手动笔前上墙、交回落「写手交稿」卡，进度落 `job.payload.progress` / `73a7202` 派写手卡露简报
    前 120 字、时间轴底部「写手已写 N 字」进度条（断线与重开以服务端为准）/ `08b92b2` 工具卡命中区域
    ≥40px / `7bf4a24`、`99dc358` 冒烟断言 + AGENTS.md（踩坑 19：模型只看工具的 data；踩坑 20：工具入参
    必须在 input_schema.properties）。
  - 口径不变项：正文不进聊天流；不新增确认步骤；计划模式闸门、聊天无写章权限、审读 / 审计 / 诊断 /
    记忆整理照旧。
- **真实 DeepSeek 试写结论**（上线前在临时数据目录、端口 3988 验证）：主智能体写任务简报 → 派写手 →
  写手自查上下文 / 配置 / 范文 → 一次交稿 1980 字 → 自检通过 → 回执 → 入书 → 沉淀；未被退回，链路成立。
- **远端旧分支清理**：已合并的旧分支删了 11 条（chore/hygiene、docs/agents-v2、feat/agent-harness、
  feat/home-nav、feat/memory-stage1、feat/mobile-polish、fix/job-lifecycle、fix/mobile-input、
  fix/remove-glm、fix/smoke-cleanup、fix/tidy-docs）；还没删的见「主 checkout 关键事实 · 分支现状」。

### 更早（2026-11-25 ～ 11-27，每条只留结论，细节看 git 历史与 AGENTS.md）

- **APK 自更新故障修复**（v4.8.1，release `09b276a`）：现象是「新版已下载」却装到旧包、报
  `安装失败(-25) 无法降级安装`；根因 Capacitor `PluginCall.getLong` 只认 `Long`，JS 传来的 versionCode
  永远读成 0 → 落到固定文件名里的旧包。修复 `0b1da5b`（原生 `getData().opt` 自己转数值、下载写 `.part`
  并核对字节数与包内真实 versionCode）+ `9615fdd`（`versionCodeOf` 改用 int 形式）。详见 AGENTS.md 踩坑 17。
- **A 工程卫生 + 部署门禁** `chore/hygiene`（11-25，合并 65df5f2，APK v4.5.0）：清死代码与死依赖；
  biome 纳管 mobile+scripts；`npm test` 冒烟总入口；构建指纹进 health + deploy 加固。
- **B 后端 P1** `fix/job-lifecycle`（11-25，合并 09db98f；未出 APK）：LLM 重试读结构化状态码；
  启动接口入队即返回、可真正取消、队列先来后到、重启续跑、终态不被覆盖；`scripts/smoke-jobs.mjs`。
- **C 数据安全** `feat/data-safety`（11-25，合并 b8806c7，APK v4.6.0）：范文摘要不读全文；
  `save_character` 不覆盖活状态；分叉点保护（起点章不可删、`lines.fork_order`）；settings.json 原子写；
  每日备份 + 保留策略 + 手机端备份与恢复。
- **D 手机端打磨** `feat/mobile-polish` + `fix/mobile-input`（11-26，合并 6ffb2da + 7135079，APK v4.7.0）：
  时间轴（轻提示、失败卡可重试、较早的节点卡不退化成白话）；弹层返回键、连不上电脑端的提示、各处失败
  弹提示；阅读页与夜间模式对比度；输入框随内容增高贴底；工具卡中文名；错误翻译成作者看得懂的提示。
- **E 项目须知重写** `docs/agents-v2`（11-25，合并 c6aaa80）：AGENTS.md 只写 v2 现在仍成立的事实；
  新增 `docs/v2/HISTORY.md`（演进史）与 `docs/v1/LEGACY.md`（v1 归档）。
- **Q 全新克隆自检**（11-26，合并 5b6091a + 93b40cb）：从零 `npm ci` → `npm run verify` 全过 →
  按文档起服务一次成功。修掉冒烟临时目录泄漏（统一收尾 `scripts/temp-dir.mjs`，总入口前后比对
  Temp 下 `nm-*`）并补齐文档缺口。
- **部署漏洞修复**（11-26，7824e33，仅电脑端）：服务进程改为以启动时加载的 `dist/build-info.json`
  为准并如实上报，不再被同目录跑测试后的新构建骗过（此前 `deploy --if-stale` 被跳过 → 手机端新、
  电脑端旧）；新增 `smoke-build-info.mjs`。
- **F 首页重设计 + 底部导航 + 范文功能重做** `feat/home-nav`（11-26，合并 73304db，APK v4.8.0）：
  底部导航三项「写书 / 范文 / 设置」；写书页重设计；范文独立页 + 手机端选 txt 分片上传
  （UTF-8 / GB18030 解码）+ 阅读层（目录 / 搜索 / 进度 / 字号 / 绑定）；新增 `scripts/smoke-sample-upload.mjs`。

## 待用户真机验收（自动化测不了）

- 时间轴里的「派写手」卡与任务简报
- 「写手已写 N 字」进度条（含写到一半重开应用）
- 写手的工具卡（详情不带正文）
- 入书卡的建议钮（quickActions 修复后应出现）
- 范文页点「导入 txt」选一个手机里的 txt：文件选择器能打开、导入成功并显示字数章数
- 阅读层的实体返回键：面板打开时先关面板，再退回范文页
- 大文件（几 MB 的 txt）导入耗时与成功与否
- 应用内更新（装上 4.8.1 及以后才可靠）
- v4.7.0 打磨的旧项（板上没有验收记录，需要时再问用户）：返回键关闭弹层；输入框随内容增高、
  软键盘弹出后贴底；夜间模式（顶栏 / 目录 / 字号面板）；断网时写书页顶部的提示横幅

## 候选清单（未做，动手前先逐项重新核实证据）

- 长期记忆阶段二（全书档案：事件时间线、人物知识边界、FTS5 检索）、阶段三（巩固任务、风格检查）
  未开工（DECISIONS §14）
- 聊天模式历史仍只取末 12 条
- 聊天模式（free）对模型幻觉出的写章类工具名没有清单拦截（只靠不下发；子智能体已有清单拦截）——
  待核实未知工具名时的行为
- 既有小命中区未加大：顶部现状胶囊 30.5px、「展开全文」16.5px
- `genStyleRefs` 只留一段范文（约 1200 字）、无冒烟覆盖
- 任务简报质量待观察（真实试写里简报重复了书名信息、写手一次交满 1980 字未分段）
- 线上观察项（v4.9.0 起，板上无复核记录）：合并梗概的实际质量与长度（目标 1500 字）；证据校验的
  真实退回率；聊天先查再答是否变慢；线上 chat 任务有无 failed（`reasoning_content` 回传）
- `9615fdd`：当前安卓编译环境解析不到 `longVersionCode`，原因未查明（已改用 int 形式绕过）
- `chapter_versions` 是死表（只有建表与删除、从不写入）
- `JobKind` 含 `'rewrite'` 但没有对应 runner
- 语义检索（`docs/v2/DECISIONS.md` G10）未做，代码里是 SQL 关键词检索
- 两个旧命名的快照文件（如 `backup-del-char-20261106.db`）不匹配清理正则，永不被清理（无害）
- `lib/tickerStore.ts` 的 `acts` 是只写状态（App.tsx 的 SSE 接线仍写入，全仓无读取方；
  `progress` 自 `73a7202` 起已由时间轴进度条读取）
- 手机端 WebView 对 POST 复用死连接的行为未验证（服务重启后首个请求可能落空）
- `docs/v2/DECISIONS.md` 两处与现行不一致：§7 导出 vs `4494bc2`、D4 vs `f011c1a`；
  计划模式、M7 全对话化、G3–G5 的决策未补记（§15 N1 已提到修订 G2 / G3）
- 托盘（systray）每次启动在 Temp 留约 14 个 `systray_temp_icon*` 文件（本机已 570 个）
- 旧板遗留、未排期：生产产物迁出 worktree（现寄生在 opencode worktree 路径）；supervisor 守护
- 旧板线索、未核实：server.log 出现过 2 次 `[llm] tool save_character 参数 JSON 解析失败…已丢弃片段`，
  该日志行仍在 `llmOpenai.ts`，是否复现未查

## 明确不做

- 聊天时间轴「加载更早」（消息上限 200 条，约对应 60–100 章）
- 调研后决定不改：`purgeDraftBooks` 不加快照（草稿书按定义无用户发言）；子线删不到父线章（已有校验，非问题）

---

> **用途**：长任务的执行状态外置。会话被中断/达到限制后，任何新会话读此文件即可无损续做。
> **纪律**（写入 AGENTS.md 的约定）：
> 1. 长任务（多文件/多轮）**动手前**先把计划写到这里，再开工；
> 2. 每完成一步就更新勾选与「下一步」，不等任务全做完才写；
> 3. 新会话开始时若本文件有未完成任务，**先续做它**，不接新需求；
> 4. 任务完成（commit+push+部署）后清空回本模板。
