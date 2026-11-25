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
- 冒烟回归全集：`npm test`（=build+`scripts/smoke-all.mjs`，13 套串行，约 15s）；`npm run verify`
  = typecheck+lint+test。输出很长——后台跑+重定向到文件+只看尾部。
- 2026-11-25 基线：HEAD=0b6395d（chore(release): v4.5.0），与 origin 同步；生产 health
  `build.commit=65df5f2`。**判断生产是否落后：比对 `/api/health` 的 `build.sourceHash` 与
  `node scripts/build-info.mjs --print`**（`npm run apk` 会自动 deploy，有任务在跑时拒绝重启）。

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
- **B `fix/job-lifecycle` 后端 P1**（**开发中**）——步骤：
  - [ ] B3 入队即返回（`enqueueOrRun` 现等整轮跑完 → 手机端 30s 超时「发送失败」、重发致导演答两遍）
  - [ ] B1 AbortSignal 贯穿：取消/看门狗真正停 loop；终态写入带 `WHERE state='running'`；
        activeJobId 统一；轮内长链路（写章多段/子代理）喂狗
  - [ ] B2 approvePlan/pump 起的任务不设 activeJobId（busy 恒 false）；approvePlan 无 try/catch
  - [ ] B4 LLM 重试读 `LlmError.status`（429/5xx 现不重试）+retry-after
  - [ ] B5 上下文压缩切点落到 assistant（现以 role:'tool' 开头会被网关拒）
  - [ ] B7 工具内异常转 tool 结果（现炸整个 job）
  - [ ] B8 队列 FIFO+启动 pump+不饿死（现 `listJobs(…,10)` LIFO）
  - [ ] 附：handleInvoke 内部异常与参数错误区分（现一律 400 且不打日志）；
        启动恢复的 job 文案不是「看门狗」；LLM 错误对用户的友好文案
  - 验证：扩冒烟（取消/超时/队列顺序/入队响应时间），`npm run verify` 全绿
- **C `feat/data-safety`**：改章写 `chapter_versions`（现全仓零写入）+applyRevisePlan 修字符串
  replace 陷阱+前端回看入口；备份体系（快照修剪/每日每周/NM_BACKUP_DIR/restore 脚本/quick_check）；
  save_character 的 state/relations 仅新建生效；onboard 先 ask 后事务落库；delete_last_chapter
  分叉点保护；settings.json 原子写；message:list 游标分页
- **D `feat/mobile-polish`**：失败卡重试钮（`job.state==='failed'`）+计划卡闪「已处理」；
  时间轴「加载更早」；delta 失配 job.get 请求风暴（单在途）；BottomSheet+`useBackHandler` 关弹层
  （现零使用）；统一错误态（全项目无 isError）；整章改稿二次确认；写操作失败 toast；
  草稿书续接入口；切子页复位滚动；输入框自适应高度+键盘贴底；点击目标≥40px；
  离开阅读页恢复状态栏；切章 useQuery+失败重试；夜间主题残留对比度；工具卡 5 个裸英文名+死代码
  （`RUN_LABEL/useReports/useChapter/lastDone`）
- **E `docs/agents-v2`**：AGENTS.md 重写（257 行里 v1 遗留约 53%、流水账 37%）→
  `docs/v2/HISTORY.md`+`docs/v1/LEGACY.md` 拆分
- **候选（未排期）**：生产产物迁出 worktree（现寄生在 opencode worktree 路径）；supervisor 守护

### 下一步
线 B：开线 `fix/job-lifecycle`（worktree 默认基于 main，先 `git reset --hard feat/v2-rebuild`）
→ 亲读 jobs.ts / agent/loop.ts / director/callJson.ts / llmOpenai.ts / store.ts 的 job 段核实证据
→ 逐项修+补冒烟 → `npm run verify` → commit+push → 合并 → 主 checkout deploy + `npm run apk`
→ 更新本板（线 B 已部署，开线 C）
