# novel_maker 项目须知

## 常用命令
- `npm run dev` 启动开发（Electron 窗口）
- `npm run typecheck` 两套 tsconfig（node=主进程/preload，web=renderer）类型检查
- `npm run build` 产物到 out/
- `npm run dist` 打包 NSIS 安装包到 dist/（需先 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`，否则国内下载 Electron/NSIS 会超时）
- Lint 暂无（后续可加 eslint）

## 架构
- `src/main/` 主进程：`llm.ts`（Anthropic 兼容流式客户端，支持 tools/tool_use 流解析）、`agent.ts`（智能体 agentic loop：17 个工具绑定当前项目 CRUD，删除类与覆盖正文需 renderer 确认，maxTurns 24）、`agentSessions.ts`（agent 会话持久化到 `agent_sessions.json`）、`graph.ts`（全项目知识图谱构建：扫各板块+章节正文的 `[[]]` 生成节点/边/度数，节点携带 tags）、`settings.ts`（safeStorage 加密 API Key）、`usage.ts`（usage_log.jsonl 记账）、`db.ts`（node:sqlite 建库+迁移）、`store.ts`（项目/大纲/人物/世界观 CRUD + worldbuild_types 受控类型表，tag 与 type 命名互斥）、`skills.ts`（技能加载与 seed，按 frontmatter version 升级覆盖）、`builtin-skills.ts`（8 个内置技能模板）、`pipeline.ts`（各板块 prompt 构建：worldbuild 为两步生成——先小请求让 AI 从 type/tag 索引检索相关条目，再仅注入相关正文）、`ipc.ts`
- `src/shared/`：`types.ts` 共享类型、`tags.ts` tag 解析（`splitTags` 宽容分隔符、`splitHeadingHashtags` 剥离标题行尾 `#tag`）
- `src/preload/index.ts` contextBridge 暴露 `window.api`（含 `api.agent`、`api.graph`）
- `src/renderer/` React + Tailwind v4；页面在 `src/renderer/src/pages/`（`GraphPage.tsx` 为全局图谱页）；世界观条目 = 单 type + 多 tags（逗号分隔存储）；`components/RelationGraph.tsx` 为实时力导向图谱组件（rAF 模拟+拖拽扰动+度数大小+hover 高亮；`clusterTags` 开启时按 tag 频次 top12 设圆周锚点做聚类弹簧，节点按主 tag 着色，锚点渲染 `#tag` 分区标签，两页共用）；`components/Markdown.tsx` 为统一 markdown 展示组件（react-markdown+gfm，可选 `wiki` prop 渲染 `[[]]` 链接带 hover 预览）
- 用户数据在 Electron `userData` 目录：`settings.json`、`agent_sessions.json`、`usage_log.jsonl`、`data/novel.db`、`skills/*.md`

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
11. **编辑器即时渲染方案已放弃**（2026-09）：vditor IR 试用后回退（wikilink `[[x]]` 无法在编辑态渲染、ir 模式 destroy 必崩、cdn 需复制 public 资源），编辑仍用 AiTextarea（textarea+选中 AI 改写），仅展示侧用 Markdown 组件渲染。若再尝试 WYSIWYG 需先解决自定义语法在编辑态的渲染（如 milkdown 自定义节点）。
12. **electron-vite dev 不热重载 `src/shared/` 改动且 touch 不触发主进程 rebuild**：改 shared 下的共享模块后主进程仍跑旧代码（renderer 却 HMR 了，极易误判已生效），必须重启 dev 实例再验证；CDP 口被刚杀实例占用时（TIME_WAIT）新实例 bind 失败且无 9222 监听，直接换 `NM_REMOTE_DEBUG_PORT` 端口重启。
13. **CDP evaluate 模拟 UI 的两个坑**：①直接调 `window.api.settings.save` 不触发 App 内部 refresh，`currentProject` 不会生效，save 后 `location.reload()` 再操作；②全局按文本找 button 会撞侧栏 nav（如「图谱」），用 `button:not(aside button)` 限定主内容区。

## 约定
- API Key 仅存主进程（safeStorage），渲染进程只拿到掩码；LLM 调用全部走 IPC。
- 每次请求必须 appendUsage 记账（M2 额度展示依赖 ratelimit 头字段实测结果）。
