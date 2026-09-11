# novel_maker 项目须知

## 常用命令
- `npm run dev` 启动开发（Electron 窗口）
- `npm run typecheck` 两套 tsconfig（node=主进程/preload，web=renderer）类型检查
- `npm run build` 产物到 out/
- Lint 暂无（后续可加 eslint）

## 架构
- `src/main/` 主进程：`llm.ts`（Anthropic 兼容流式客户端）、`settings.ts`（safeStorage 加密 API Key）、`usage.ts`（usage_log.jsonl 记账）、`ipc.ts`
- `src/preload/index.ts` contextBridge 暴露 `window.api`；共享类型在 `src/shared/types.ts`
- `src/renderer/` React + Tailwind v4；页面在 `src/renderer/src/pages/`
- 用户数据在 Electron `userData` 目录：`settings.json`、`usage_log.jsonl`

## 踩坑记录
1. **依赖版本钉死**：electron-vite@5 的 peer 只支持 vite ^5||^6||^7，不要升 vite 8；vite 7 对应 `@vitejs/plugin-react@^5`（v6 要求 vite 8）。
2. **Electron 二进制下载**：项目 `.npmrc` 的 `electron_mirror` 会被 npm 11 警告 Unknown config 且 postinstall 拿不到，导致 `electron-vite dev` 报 `Error: Electron uninstall`。修复：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`。node_modules 重装后要检查 `node_modules/electron/dist/` 是否存在。
3. **preload 产物是 `out/preload/index.mjs`**（type:module 下），主进程加载路径要写 `index.mjs` 不是 `index.js`；main 产物仍是 `index.js`。
4. Git Bash 里 taskkill 需要 `MSYS_NO_PATHCONV=1`，否则 `/F /T /IM` 参数被误转成路径。

## 约定
- API Key 仅存主进程（safeStorage），渲染进程只拿到掩码；LLM 调用全部走 IPC。
- 每次请求必须 appendUsage 记账（M2 额度展示依赖 ratelimit 头字段实测结果）。
