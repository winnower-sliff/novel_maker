# 任务交接板

## 进行中：移除 GLM + 为 DeepSeek 做更强的长期记忆（2026-11-27 开工）

- 用户指令（原话）：「继续自己检查问题并修复。在APP中取消使用glm的能力。在该APP使用dpsk的时候幻觉和遗忘很严重。
  参考最新的功能为APP提供更复杂高效的长期记忆能力，以维持更好的风格统一与逻辑一致。」
- ① APK 安装故障——**已完成**（见下方「APK 自更新故障修复」）。
- ② 移除 GLM 能力——**开发线实施中**（2026-11-27）：分支 `fix/remove-glm`，worktree
  `C:\Users\14270\.local\share\opencode\worktree\754ca1\noglm`，基于 154f026，子代理实施
  `ses_de75eb4f0ffe1Jiry10VfNWmtp`；完成标准 = 门禁绿 + `npm test` 20 套（新增 `smoke-config.mjs`）
  + 已推送 → 主 checkout 合并 → `npm run verify` → `npm run apk`（主进程与手机端都有改动，自动 deploy）。
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
- ③ 长期记忆——**调查中，未动手**。目标：风格统一 + 逻辑一致；缓解 DeepSeek 的幻觉与遗忘。
- 计划：先拿三份只读调查结论（GLM 落点 / 现行记忆机制全貌 / 业界最新做法）→ 把 ②③ 的具体设计
  与分步计划写回本段 → 各开一条开发线（worktree + 子代理）实施 → 主 checkout 验收、合并、出包。
- 下一步：② 验收子代理的 `fix/remove-glm`（看提交、`npm test` 结果、与 origin 同步）→ 主 checkout
  合并出包；③ 等两份只读调查（现行记忆机制全貌 `ses_de763d6c1ffetfFKcMpNgXyP1h`、业界最新做法
  `ses_de763d6c0ffePNneHjjB3r9VmC`）→ 设计写回本段 → 开线。若本文件停在这里，新会话从这里接着做，
  ② 不要重做，③ 不要从头调查（先看主会话是否已有结论）。

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
- **未完成**：用户指令 ②移除 GLM 能力、③为 DeepSeek 做更强的长期记忆——见顶部「进行中」段，
  新会话先续做它，不接新需求。
- 生产现状：电脑端 4.8.0 / `build.sourceHash=4db9ee339e606552`（PID 不固定，需要时查 health）；
  手机端更新源 APK **v4.8.1-202611270010**（versionCode 29928490；用户这一次需用浏览器打开
  `http://100.100.62.8:3910/api/mobile/apk?vc=29928490` 安装，之后应用内更新才可靠）。
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
- 冒烟回归全集：`npm test`（=build+`scripts/smoke-all.mjs`，19 套串行）；`npm run verify`
  = typecheck+lint+test，即完整门禁。输出很长——后台跑+重定向到文件+只看尾部。
- 2026-11-26 基线：HEAD=0eaefde（`chore(release): v4.8.0`，tag v4.8.0 已推送），与 origin 同步；
  生产 health `build.commit=0eaefde`、`build.sourceHash=4db9ee339e606552`；
  手机端更新源 APK v4.8.0-202611262112（含首页重设计 + 底部导航 + 范文功能重做）。
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
