# 任务交接板

> **用途**：长任务的执行状态外置。会话被中断/达到限制后，任何新会话读此文件即可无损续做。
> **纪律**（写入 AGENTS.md 的约定）：
> 1. 长任务（多文件/多轮）**动手前**先把计划写到这里，再开工；
> 2. 每完成一步就更新勾选与「下一步」，不等任务全做完才写；
> 3. 新会话开始时若本文件有未完成任务，**先续做它**，不接新需求；
> 4. 任务完成（commit+push+部署）后清空回本模板。

---

## 当前任务：自主优化长跑（自己提需求自己改，不要停）

### 授权与规则（用户 2026-11-25）
- 「检查该项目并进行你觉得值得的优化，自己提需求自己改不要停」
- 「记得按你觉得值得的需求进行 git 管理」→ 每个需求包 = 一个独立开发线（lane-flow）：
  `worktree_create` → `session_move` → 从 `feat/v2-rebuild` 开 `feat/<名>`/`fix/<名>` → `npm ci`
  → 开发 → 门禁（typecheck+biome）+冒烟 → commit+push → 回**主 checkout**（本目录）
  `git merge --no-ff` → push → `worktree_remove` → **在主 checkout** 跑 `npm run deploy`（主进程有改动）
  / `npm run apk`（前端有改动）
- 单点小修（文档、一行改动）不开线，直接在主 checkout 提交。

### 主 checkout 关键事实
- 主目录：`C:\Users\14270\.local\share\opencode\worktree\754ca1\v2-rebuild`（分支 feat/v2-rebuild）
- **生产 server 跑的就是主 checkout 的 `dist/main/index.js`**（deploy.mjs `cwd: root`）——
  **开发线里绝不 deploy / 绝不 build-apk**（会让生产寄生在待删的 worktree 上、且会打 tag 推版本）；
  开发线只靠冒烟脚本验证主进程改动。合并回主 checkout 后再 deploy。
- `npm run apk` = `build-apk.mjs`（v4.5 起两阶段）：先 `deploy.mjs --if-stale` 确保生产 server
  是当前源码的构建 → 出包 → **全部成功才**提交 `chore(release): vX` + 打 tag（失败回滚版本号）。
- 冒烟回归全集：`npm test`（=build+`scripts/smoke-all.mjs`，14 套串行，约 45s）；`npm run verify`
  = typecheck+lint+test。输出很长——后台跑+重定向到文件+只看尾部。
- 2026-11-25 基线：HEAD=af6aab2，与 origin 同步；生产 health `build.commit=af6aab2`（PID 92592）。
  **判断生产是否落后：比对 `/api/health` 的 `build.sourceHash` 与
  `node scripts/build-info.mjs --print`**（`npm run apk` 会自动 deploy，有任务在跑时拒绝重启）。
- **只改主进程的提交不出 APK**（内容相同的包只会白白打断用户安装）；手机端有改动才 `npm run apk`。
- 拆提交后逐个中间提交验门禁的手法：`git worktree add --detach <tmp> <sha>` + `npm ci` + tsc 两套
  + biome；按依赖顺序提交（库层 → 调用层），强耦合的重构（如 jobs.ts+store.ts+loop.ts）合成一个提交。
- 上下文纪律：大文件分段读、读完即压缩；冒烟输出绝不直接进上下文。

### 已确认的问题/机会（开工前调研）
1. **部署一致性无机器保证**：health 的 version 是 deploy 时的 package.json 版本，而 build-apk 之后
   才 bump → 「server 版本落后 package.json」恒成立，AGENTS.md 里那条判据不可靠；「改主进程忘 deploy」
   已实锤过一次。→ 源码指纹门禁。
2. **备份**：数据目录 184MB，28 个 `backup-*.db` 全是删除操作前的快照（无保留策略、无定期全量备份）。
3. **工程卫生**：`"test": "vitest run"` 无任何测试文件（vitest 死依赖，`npm test` 必失败）；
   biome includes 只有 `src/**`（mobile/src 零 lint）；无 CI；Capacitor 模板残留
   （`com/getcapacitor/myapp/Example*Test.java`）；AGENTS.md 引用不存在的 `docs/v2/REQUIREMENTS.md`
   与 `.opencode/skill/{reload,reviewer}`（v1 遗留）；build-apk.mjs 注释仍提 `src/wizard`。
4. **真实故障线索**（server.log）：`[llm] tool save_character 参数 JSON 解析失败（N 字符），已丢弃片段`
   出现过 2 次；usage 里 deepseek 的 cacheRead 恒 0（疑似未读 `prompt_cache_hit_tokens`）。均待核实现状。
5. 阅读页夜间模式只联动了正文+底栏（顶栏/目录/Aa 面板仍亮色）；切章疑似双请求+乱序竞态（待核实）。

### 后台审查（结果到齐后定稿需求包清单）
- 后端健壮性：ses_deeeae788ffdvZ0nM9Hcxe3jAu
- 移动端体验：ses_deeeae787ffe6zKX3A2mRQX2Lp
- 数据安全与运维：ses_deeeae784ffeDg8nIdngIcWTAQ

### 开线坑（2026-11-25 实锤）
- `worktree_create` 默认从 **main（v1）** 拉新 worktree，不是 feat/v2-rebuild！开线后必须
  `git switch -c <branch> && git reset --hard feat/v2-rebuild`（或先 reset 再开分支）。
- 新 worktree 无 node_modules，`npm ci` 约 6s（218 包）；mobile-app/node_modules 仅 build-apk 需要。

### 需求包（三份审查去重后定稿；状态 待做/开发中/待合并/已部署）
- **A `chore/hygiene` 工程卫生+部署门禁**（**已部署** 2026-11-25，合并提交 65df5f2，APK v4.5.0）
  - b027707 死代码 / 45d0e93 biome 纳管 mobile+scripts（BottomSheet 统一弹层）/ aee1226 删裸 LLM
    代理 / 22016f8 死依赖+`npm test` 冒烟总入口 / 862051e 构建指纹+deploy 加固 / 926ce9d 仓库卫生
  - 遗留给线 D：BottomSheet 尚未接返回键；离开阅读页未恢复状态栏
- **B `fix/job-lifecycle` 后端 P1**（**已部署** 2026-11-25，合并提交 09db98f；无手机端改动故未出 APK）
  - a4582d3 LLM 层：重试判定读 `LlmError.status`（429/5xx 此前不重试）+retry-after；流中断/挂起
    （120s 无新数据）识别为可重试错误；取消信号贯穿；缓存命中记账；`onRestart` 回调
  - 43b978c steps：`applyRevisePlan` 按字面量替换（多处命中全换、不受 `$&` 影响）；生成步骤支持
    取消；删 genOutline/genScenes/genRecap/genChat 死代码
  - 1b3ac5f 任务生命周期：启动接口**入队即返回**（此前等整轮，手机 30s 超时显示「发送失败」）；
    `running: Map<jobId, AbortController>` 取代单变量，串行不再失守；取消/看门狗真正中止在跑的
    请求；终态写入带 `WHERE state='running'`（取消不被 done 覆盖）；队列 FIFO；重启后 queued 续跑、
    running 标「服务重启被打断」；恢复正文进度事件+写章全程喂狗；入书后失败的任务重试不重复入书；
    上下文压缩切点落到 assistant；工具内异常不再炸整个任务；`scripts/smoke-jobs.mjs` 28 断言
  - e876dbe invoke 异常留痕
  - 未做（留给后续）：LLM 错误对用户的友好文案（现直接显示底层错误信息）
  - 遗留给线 D：BottomSheet 尚未接返回键；离开阅读页未恢复状态栏
- **C `feat/data-safety`**（**已部署** 2026-11-25，合并提交 b8806c7；APK v4.6.0-202611251900，release fbdbe4b）：
  - 9186eba 范文摘要链路不再读全文（列表/绑定校验/待导入预览只读文件头；导入上限 3000 万字）
  - 7c336c9 `save_character` 改已有人物时不再覆盖活状态（state 仅新建时可带）
  - 95835de 开书引导：确认草案**先问后存**（下一阶段生成失败不重复入库）；重复确认幂等返回最新草案；
    `onboard:answer` 增加 `expectStage`，阶段不符不再误确认下一阶段；手机端失败保留选项可重试
  - f3d6e26 分叉点保护：起点章不可删（工具层先拦，不白占快照）；`lines.fork_order` 记录分叉点序号，
    分叉点章不在时子线仍保住更早的祖先章
  - 33971d9 settings.json 原子写（tmp→rename）；JSON 损坏时改名 `settings.json.corrupt-<时间>` 保全后用默认值
  - e2306cf 备份体系：`src/main/backup.ts` 每日一份 gzip（近 7 天全留、更早每周 1 份共 8 桶）；删除前快照
    （del-/card-/char-/book-/line-/fore-）只留最新 30 份，manual/pre-migrate/pre-restore 永不自动清；
    `PRAGMA user_version`+结构升级前自动快照；通道 `backup:list/create/restore`（进程内换库：先留
    pre-restore 快照→关连接→换文件→重开，失败自动换回）；设置页「备份与恢复」可立即备份/一键恢复
  - 冒烟：smoke-backup 24、smoke-fork 13、smoke-onboard 26、smoke-sample 14、smoke-char-tags 9；全量 17 套
  - 调研后**不改**的：`purgeDraftBooks`（草稿书按定义无用户发言，不加快照）；子线删不到父线章（已有校验）
  - 操作备忘：恢复入口=手机设置页「备份与恢复」；备份文件在数据目录 `%APPDATA%/novel-maker-v2`
- **D `feat/mobile-polish`**（**开发中**）：失败卡重试钮（`job.state==='failed'`）+计划卡闪「已处理」；
  时间轴「加载更早」；delta 失配 job.get 请求风暴（单在途）；BottomSheet+`useBackHandler` 关弹层
  （现零使用）；统一错误态（全项目无 isError）；整章改稿二次确认；写操作失败 toast；
  草稿书续接入口；切子页复位滚动；输入框自适应高度+键盘贴底；点击目标≥40px；
  离开阅读页恢复状态栏；切章 useQuery+失败重试；夜间主题残留对比度；工具卡 5 个裸英文名+死代码
  （`RUN_LABEL/useReports/useChapter/lastDone`）
  - 证据明细（审查时的文件与现象；**行号已被线 A 的格式化与 BottomSheet 迁移挪动，动手前按符号名重新定位**）：
    - D1 `JobCard.tsx` 重试钮条件 `active && active.id===job.id`，而 `queries.ts` 的 active 永不含
      failed → 失败卡永远没有重试钮；计划消息先于 job 状态到达时先显「已处理」约 5 秒
      （修：onAppend 收到 `meta.kind==='job'` 时一并失效 `qk.jobs`）
    - D2 `MessageRow.tsx` 的 jobsById 查不到就退化成白话气泡；`store.listJobs` 默认 limit 20、
      消息封顶 200 且无「加载更早」→ 聊 20 句后早期「已入书」卡退化成白话
    - D3 `App.tsx` `if (st.chatText.length !== total - chunk.length) void window.api.job.get(jobId)`
      每个 chunk 一次请求（回前台/重连/冷启动后落库快照恒落后）→ 单在途 + 丢弃 `total<=chatTotal` 的 delta
    - D4 `lib/backHandler.ts` 的 `useBackHandler` 全项目零使用；`App.tsx` 返回键 consumeBack →
      closeBook → setTab('shelf') → exitApp，弹层开着会直接关书 → 在 BottomSheet 内接一次
    - D5 全项目无 isError：电脑没开机时书架显示「还没有书」；Lines/Read「加载中…」永久；
      Cards/Settings 范文「还没有范文」
    - D6 `QuickActionsBar.tsx` 整章重写/加长/缩短一键覆盖无确认
    - D7 写操作失败静默无 toast（Shelf 归档、Lines 删线、Read 选段修改、Settings）
    - D8 `Shelf.tsx` 过滤 `!b.archived && !b.draft`，开新书中途退出 → 草稿书成孤儿无续接入口
      （修：书架显示 draft 书 +「继续开书」）
    - D9 `BookWorkspace.tsx` 的 `<main overflow-y-auto>` 切子页不复位滚动（修：`key={bookSub}`）
    - D10 `InputBar.tsx` textarea rows=1 不随内容增高；`Write.tsx` ResizeObserver 未观察列表自身
      → 键盘弹出后不贴底
    - D11 点击目标 <40px：Shelf ⋯ 按钮、Cards 删除、Lines 切线/删线
    - D13 `Read.tsx` theme effect 无 cleanup → 离开阅读页系统栏不恢复（修：cleanup 调 `applySystemBars('light')`）
    - D14 `Read.tsx` `chapter.get(...).then()` 无 catch → 断网永远「正在打开…」；prev/next 手动
      `chapter.get` 与 effect 重复且无 alive 守卫
    - D15 深色主题残留：Settings `bg-orange-900/60 text-orange-700`、Lines `border-red-900 bg-red-950/50
      text-red-600`、Connect；server undefined 时先显红色「未连接」
    - D16 `pages/write/labels.ts` 的 `TOOL_LABEL` 缺 propose_chapter/request_review/request_audit/
      list_card_kinds/rename_card_kind 中文名；死代码 `RUN_LABEL/useReports/useChapter/lastDone`、
      ticker 的 acts/progress
    - 自线 B 新增：LLM 错误对用户不友好（直接显示底层错误信息）；手机端 Chromium fetch 对 POST
      复用死连接的行为未验证（server 重启后首个请求可能落空）；夜间模式只联动正文+底栏，
      BookWorkspace 顶栏/目录视图/Aa 面板仍亮色
- **E `docs/agents-v2`**：AGENTS.md 重写（257 行里 v1 遗留约 53%、流水账 37%）→
  `docs/v2/HISTORY.md`+`docs/v1/LEGACY.md` 拆分
- **候选（未排期）**：生产产物迁出 worktree（现寄生在 opencode worktree 路径）；supervisor 守护

### 下一步
线 D `feat/mobile-polish`：开线（worktree 默认基于 main，先 `git reset --hard feat/v2-rebuild`，`npm ci`）
→ 逐项亲读 mobile/src 核实上面的 D 证据（行号已被格式化与 BottomSheet 迁移改动，按现象搜）
→ 按价值排序实现（建议先做：失败卡重试钮+统一错误态+BottomSheet 返回键+delta 补拉请求风暴+切章容错，
  再做草稿书续接、输入框自适应、点击目标、夜间主题残留、工具中文名）
→ 验证：mobile tsc + biome + `npx vite build --config mobile/vite.config.ts` + check-tailwind-classes
→ 按项提交 → push → 主 checkout `git merge --no-ff` → push → 删 worktree → `npm run apk`（纯前端改动，
  build-apk 自动确认 server 最新）→ 更新本板（线 D 已部署，开线 E `docs/agents-v2`）
