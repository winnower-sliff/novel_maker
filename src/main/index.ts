// v2 入口：纯 Node 常驻服务 + 系统托盘，无 Electron。
import { hasPassword, initConfig } from './config.js'
import { connectHost, firstRunInit } from './connect.js'
import { startServer } from './server.js'
import { getServerStatus } from './serverState.js'
import { shutdown, startTray } from './tray.js'

process.title = 'novel-maker'

async function main(): Promise<void> {
  initConfig()

  // 首次启动：生成随机密码 → first-run.txt → 记事本打开，手机扫码/输密码连接
  if (!hasPassword()) {
    const password = firstRunInit()
    console.log(`[novel-maker] 首次启动，访问密码：${password}（已写入 first-run.txt）`)
  }

  await startServer()
  const status = getServerStatus()
  const { host, port } = connectHost()
  console.log(`[novel-maker] 服务已启动：${host}:${port}（版本 ${status.version}）`)

  try {
    await startTray()
  } catch (err) {
    // 托盘失败不致命：服务照常跑，靠日志/手动重启
    console.error('[novel-maker] 托盘启动失败（服务继续运行）：', err)
  }
}

main().catch((err) => {
  console.error('[novel-maker] 启动失败：', err)
  process.exitCode = 1
})

let shuttingDown = false
async function exitGracefully(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[novel-maker] 收到 ${signal}，正在退出…`)
  await shutdown() // stopServer → tray.kill → process.exit(0)
}

process.on('SIGINT', () => void exitGracefully('SIGINT'))
process.on('SIGTERM', () => void exitGracefully('SIGTERM'))

// 常驻服务兜底：未捕获异常只记录不退出（请求路径各自 try/catch），
// 连续崩溃的极端情况由用户经托盘/任务管理器重启。
process.on('uncaughtException', (err) => {
  console.error('[novel-maker] uncaughtException：', err)
})
process.on('unhandledRejection', (err) => {
  console.error('[novel-maker] unhandledRejection：', err)
})
