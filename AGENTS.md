# novel_maker 项目须知

## 常用命令
- `npm run dev` 启动开发（Electron 窗口）
- `npm run typecheck` 两套 tsconfig（node=主进程/preload，web=renderer）类型检查
- `npm run build` 产物到 out/
- `npm run dist` 打包 NSIS 安装包到 dist/（需先 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`，否则国内下载 Electron/NSIS 会超时）
- Lint 暂无（后续可加 eslint）

## 架构
- `src/main/` 主进程：`llm.ts`（Anthropic 兼容流式客户端，支持 tools/tool_use 流解析；`probeModels` 按 provider 分流探测：glm/custom 走 `/v1/models`+x-api-key，deepseek 走根域 `/models`+Bearer，ollama 走 `/v1/models` 失败回退 `/api/tags`）、`providers` 预设见 `src/shared/providers.ts`（glm/deepseek/ollama/custom：baseUrl、默认模型、内置模型列表、needsKey、supportsCache、文案）、`agent.ts`（智能体 agentic loop：20 个工具绑定当前项目 CRUD，删除类与覆盖正文需 renderer 确认，maxTurns 24；list 类工具带 过滤/分页/摘要（total/hasMore/byCategory），配套 get_worldbuild/get_character 单条全文，单次工具结果上限 30000 字，截断时返回补救指引）、`agentSessions.ts`（agent 会话持久化到 `agent_sessions.json`）、`graph.ts`（全项目知识图谱构建：扫各板块+章节正文的 `[[]]` 生成节点/边/度数，节点携带 tags）、`settings.ts`（safeStorage 按 provider 分别加密 API Key；`provider` + `profiles`（各 provider 独立 baseUrl/defaultModel/modelRouting/promptCache）+ `apiKeys`，旧单 key/baseUrl 读取时自动迁移为 glm；`getLlmAuth()` 为唯一鉴权入口）、`usage.ts`（usage_log.jsonl 记账）、`db.ts`（node:sqlite 建库+迁移）、`store.ts`（项目/大纲/人物/世界观 CRUD + worldbuild_types 受控类型表（带 priority 排序：预设 地理<势力<历史<力量体系<物品，其他恒最后，同优先级拼音序），tag 与 type 命名互斥）、`skills.ts`（技能加载与 seed，按 frontmatter version 升级覆盖）、`builtin-skills.ts`（8 个内置技能模板）、`pipeline.ts`（各板块 prompt 构建：worldbuild 为两步生成——先小请求让 AI 从 type/tag 索引检索相关条目，再仅注入相关正文；生成结果不落库，返回预览条目由 renderer 挑拣后经 worldbuildSaveBatch 落库；人物生成卡标题行尾 `#tag` 解析后随卡落库）、`ipc.ts`
- `src/shared/`：`types.ts` 共享类型、`tags.ts` tag 解析（`splitTags` 宽容分隔符、`splitHeadingHashtags` 剥离标题行尾 `#tag`）
- `src/preload/index.ts` contextBridge 暴露 `window.api`（含 `api.agent`、`api.graph`）
- `src/renderer/` React + Tailwind v4；页面在 `src/renderer/src/pages/`（`GraphPage.tsx` 为全局图谱页：额外拉取世界观/人物数据，单击世界观/人物节点就地弹预览（Markdown+wiki 链式切换预览目标），大纲/伏笔节点跳转对应板块）；世界观条目 = 单 type + 多 tags（逗号分隔存储），AI 生成走 `components/WbGenOverlay.tsx` 弹窗（焦点跟随页面筛选、两步检索预览行、流式进度、生成结果勾选挑拣后批量入库，任务状态在 `lib/wbGenStore.ts` 供侧栏 badge 跨页提示）；`components/RelationGraph.tsx` 为实时力导向图谱组件（rAF 模拟+拖拽扰动+度数大小+hover 高亮；`clusterTags` 开启时 count≥3 的高频 tag（数量不设上限）形成隐式质心簇：节点按主 tag（自身 tags 中频次最高者）着色并受质心弹簧+簇间斥力聚拢，无高频 tag 节点中性灰；#tag 分区标签为簇中心大字水印（zIndex 低于节点、字号随簇规模缩放、可点击筛选），hover tag 水印仅高亮该簇成员节点（不高亮边），hover 节点时其所属各簇水印提亮（不扩散高亮簇成员），水印可由 `showTagLabels` 开关隐藏，两页共用）；`components/Markdown.tsx` 为统一 markdown 展示组件（react-markdown+gfm，可选 `wiki` prop 渲染 `[[]]` 链接为 span 带 hover 预览）
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
12. **electron-vite dev 不热重载 `src/shared/`、`src/preload/` 改动且 touch 不触发 rebuild**：改 shared 后主进程仍跑旧代码（renderer 却 HMR 了，极易误判已生效）；改 preload 后 renderer HMR 的新代码会调用旧 preload 产物里不存在的方法（表象：`window.api.xxx is not a function`，确认 out/preload/index.mjs 里 grep 不到新方法即中招），都必须重启 dev 实例再验证；CDP 口被刚杀实例占用时（TIME_WAIT）新实例 bind 失败且无 9222 监听，直接换 `NM_REMOTE_DEBUG_PORT` 端口重启。
13. **CDP evaluate 模拟 UI 的两个坑**：①直接调 `window.api.settings.save` 不触发 App 内部 refresh，`currentProject` 不会生效，save 后 `location.reload()` 再操作；②全局按文本找 button 会撞侧栏 nav（如「图谱」），用 `button:not(aside button)` 限定主内容区。
14. **GLM Anthropic 兼容端点的 thinking 陷阱**：glm-4.6 会默认启用思考且思考 token 计入 `output_tokens`，但思考内容**不经过 text_delta**——长输出任务的 max_tokens 会被思考吃光，正文只收到极少字符甚至为空（表象：usage 显示 8192 tokens 但 parse 出空「未命名条目」）。修复：请求体统一带 `thinking: {type:'disabled'}`（llm.ts chatStream），worldbuild 生成 maxTokens 提至 16384；判断依据：outputTokens 远大于 text 长度即中招。
15. **内置 skill 的 version 是覆盖开关**：frontmatter 无 version 视为 0，改 `builtin-skills.ts` 里的 skill 后必须 bump version 才会覆盖 userData/skills 下的旧副本（现为 worldbuilder v7、character-smith v1，均含「条目/人物必须带 tag」硬要求）；智能体不加载 skills（系统提示硬编码），标签纪律要同步写进 `buildSystemPrompt` 与工具描述。
16. **多 provider（GLM/DeepSeek/Ollama）接入只走 Anthropic 兼容协议**（2026-09 实机验证）：DeepSeek 官方端点 `https://api.deepseek.com/anthropic`（不支持模型名自动映射到 `deepseek-flash`），本地 Ollama `/v1/messages`（需 v0.12+，无需 Key，代码里用占位 `'ollama'` 走 x-api-key）。注意：①Ollama 不支持 `cache_control`、无 `/v1/models` 的 Anthropic 形态，探测要回退 `/api/tags`；②DeepSeek 模型列表在根域 `/models` 且用 Bearer，探测时要剥掉 `/anthropic` 后缀；③DeepSeek/Ollama 下 promptCache 必须强制关（否则发出未支持的 cache_control）；④Ollama 实机跑通 agent 全链路（qwen3:14b 工具调用/tool_result 回灌正常）。

## 约定
- API Key 仅存主进程（safeStorage，按 provider 分别保存），渲染进程只拿到掩码；LLM 调用全部走 IPC，鉴权统一走 `getLlmAuth()`（Ollama 无需真实 Key，用占位符）。
- 每次请求必须 appendUsage 记账（M2 额度展示依赖 ratelimit 头字段实测结果）。
- 更新型写入语义：可选字段未传（undefined）保留原值，显式空串才清空（`store.saveWorldbuild/saveCharacter`）；AI 修订/agent 保存若没输出 tags 一律保留旧标签，避免只改正文时清空标签。
