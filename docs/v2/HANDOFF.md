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
- `npm run apk` = `build-apk.mjs`，开头会 `bumpVersion`（按 Conventional Commits 升版+打 tag）——
  只在合并后、所有待发包都就绪时跑一次（多个需求包可合并成一个 APK 版本）。
- 冒烟回归全集：smoke-m2 / m4 / m5 / m6 / sample / archive / char-tags / export / http-patch /
  partial-update / plan（m2·m4·m5·m6 依赖 smoke-m3-stub 队列桩，**队列顺序敏感**）。
- 2026-11-25 基线：HEAD=645815b，工作区干净，与 origin 同步；生产 health 4.1.0（=4494bc2 时的
  版本号，export 路由已验证 200），即生产主进程与 HEAD 一致（其后两个提交均纯前端）。

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

### 需求包（定稿后在此维护：状态 开发中/待合并/已部署）
- [ ] 待定稿

### 下一步
等三份审查报告 → 去重核实 → 按价值排序定稿需求包 → 从第 1 包开始开线。
