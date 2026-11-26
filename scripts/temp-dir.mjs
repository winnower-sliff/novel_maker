// 冒烟脚本的收尾工具。临时数据目录用完必须删掉：否则每跑一次 npm test，系统 Temp 里就多出十来个 nm-* 目录。
//
// Windows 上两件事会让 rmSync 直接报 EPERM / EBUSY，所以收尾顺序固定：
//   ① 先 stopChild()：子进程（dist server、LLM 桩）真正退出之前，它打开的 novel.db 删不掉；
//   ② 脚本自己 closeDb()：本进程直调 store / 工具时开着的 sqlite 句柄同样占着文件；
//   ③ 最后 removeTempDir()：仍被占用就稍等重试；实在删不掉只报告——总入口 smoke-all.mjs 会据此判失败。
//
// 收尾之后不要 process.exit()，用 process.exitCode 让进程自然退出：连续几次 fetch 之后立刻
// process.exit()，Windows 上会以 libuv 断言崩溃收场（见 AGENTS.md 踩坑 13）。
//
// 文件名不带 smoke- 前缀：smoke-all.mjs 把 scripts/smoke-*.mjs（桩除外）当成冒烟套件逐个执行。
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 「被别的进程占着」在 Windows 上的几种写法 */
const BUSY = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY'])

const killTree = (pid) => {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
  } else {
    try {
      process.kill(pid)
    } catch {
      /* 已退出 */
    }
  }
}

/** 结束冒烟拉起的子进程并等它真正退出（已经退出则立即返回） */
export function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    // 兜底：kill() 之后迟迟不回报 exit（被强杀的进程不一定还发事件）就按进程树强杀，不再等
    const timer = setTimeout(() => {
      killTree(child.pid)
      resolve()
    }, 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

/** 删临时目录（连同里面的一切）。被占用时每 400ms 重试一次，最多 retries 次；返回是否删干净 */
export async function removeTempDir(dir, retries = 10) {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch (e) {
      if (!BUSY.has(e.code) || attempt >= retries) {
        console.error(`[smoke] 临时目录没删掉，可手动删除：${dir}（${e.code ?? e.message}）`)
        return false
      }
      await sleep(400)
    }
  }
}
