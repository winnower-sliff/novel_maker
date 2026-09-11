# novel_maker 项目须知

## 常用命令
- `npm run dev` 启动开发（Electron 窗口）
- `npm run typecheck` 两套 tsconfig（node=主进程/preload，web=renderer）类型检查
- `npm run build` 产物到 out/
- `npm run dist` 打包 NSIS 安装包到 dist/（需先 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`，否则国内下载 Electron/NSIS 会超时）
- Lint 暂无（后续可加 eslint）

## 架构
- `src/main/` 主进程：`llm.ts`（Anthropic 兼容流式客户端）、`settings.ts`（safeStorage 加密 API Key）、`usage.ts`（usage_log.jsonl 记账）、`db.ts`（node:sqlite 建库）、`store.ts`（项目/大纲/人物/世界观 CRUD）、`skills.ts`（技能加载与 seed）、`builtin-skills.ts`（8 个内置技能模板）、`ipc.ts`
- `src/preload/index.ts` contextBridge 暴露 `window.api`；共享类型在 `src/shared/types.ts`
- `src/renderer/` React + Tailwind v4；页面在 `src/renderer/src/pages/`
- 用户数据在 Electron `userData` 目录：`settings.json`、`usage_log.jsonl`、`data/novel.db`、`skills/*.md`

## 踩坑记录
1. **依赖版本钉死**：electron-vite@5 的 peer 只支持 vite ^5||^6||^7，不要升 vite 8；vite 7 对应 `@vitejs/plugin-react@^5`（v6 要求 vite 8）。
2. **Electron 二进制下载**：项目 `.npmrc` 的 `electron_mirror` 会被 npm 11 警告 Unknown config 且 postinstall 拿不到，导致 `electron-vite dev` 报 `Error: Electron uninstall`。修复：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`。node_modules 重装后要检查 `node_modules/electron/dist/` 是否存在。
3. **preload 产物是 `out/preload/index.mjs`**（type:module 下），主进程加载路径要写 `index.mjs` 不是 `index.js`；main 产物仍是 `index.js`。
4. Git Bash 里 taskkill 需要 `MSYS_NO_PATHCONV=1`，否则 `/F /T /IM` 参数被误转成路径。
5. **原生模块一律不用，SQLite 用内置 `node:sqlite`（DatabaseSync）**：Electron 44 内置 Node 24.20，node:sqlite 可用且带 FTS5。better-sqlite3 在 electron 44 ABI 无 prebuild、本地编译需要 VS Build Tools（本机没有），已验证不可行并卸载。
6. 杀测试用 electron 进程时用 PowerShell 按启动时间过滤（`Get-Process electron | Where StartTime < 2min`），避免误杀用户自己开着的 dev 实例。

## 约定
- API Key 仅存主进程（safeStorage），渲染进程只拿到掩码；LLM 调用全部走 IPC。
- 每次请求必须 appendUsage 记账（M2 额度展示依赖 ratelimit 头字段实测结果）。
