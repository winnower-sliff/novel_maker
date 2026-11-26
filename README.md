# novel_maker v2

给小说作者用的「AI 导演」：电脑端跑一个常驻服务，手机 App 是唯一入口。你和导演聊天，它负责查设定、写正文、沉淀人物与伏笔——所有生成内容都由它调用工具落库，聊天里只出现对话、工具卡和成品卡。

## 它怎么工作

- **电脑端**：纯 Node 常驻服务 + 系统托盘（无 Electron），内嵌 HTTP 接口与 SSE 事件，数据存单个 SQLite 文件。
- **手机端**：Capacitor 壳 + 本地 Web 包，经 Tailscale 访问电脑端；更新走 App 内自更新。
- **数据模型**：分叉树——不分卷、不做真删除；每本书一条激活线，可从任意章之后开新线，设定随线独立演化。
- **写作循环**：写作页顶部有现状摘要；在对话里说「写下一章」（可带倾向），导演 agent 自主定走向、写正文、自检后入书，过程中沉淀人物状态、设定卡、伏笔。开了「先计划」的书会先出本章计划书，你过目确认后再动笔；写完一章就停，不会自动连写。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/main/` | 电脑端服务：HTTP、任务调度、分叉树数据层、agent 循环与工具 |
| `src/shared/` | 前后端共享的类型与接口契约（zod，单一事实源） |
| `mobile/` | 手机端 Web 应用（React + Tailwind v4） |
| `mobile-app/` | Capacitor 壳与 Android 工程 |
| `scripts/` | 构建、部署、出包、冒烟 |

## 常用命令（Windows，Node ≥ 24）

```sh
npm ci
npm run verify     # 类型检查 + lint + 构建 + 全部冒烟
npm run dev        # 开发模式
npm run deploy     # 构建并重启电脑端服务（有写作任务在跑时会拒绝）
(cd mobile-app && npm ci)  # 出 APK 前先装一次 Android 壳的依赖（独立的 npm 包，根目录 npm ci 装不到）
npm run apk        # 出 APK 并部署为更新源；主进程有改动会先自动部署服务
```

## 数据在哪

默认在 `%APPDATA%\novel-maker-v2`（环境变量 `NM_DATA_DIR` 可改）：`novel.db` 是全部数据，`settings.json` 是配置与模型密钥，`imports\` 放待导入的范文。

## 更多

- 给 AI 编码助手的项目须知：`AGENTS.md`
- 决策记录与任务交接板：`docs/v2/`
