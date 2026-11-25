// 冒烟总入口：串行跑全部 scripts/smoke-*.mjs（LLM 桩与总入口自身除外），汇总通过/失败/耗时，任一失败 exit 1。
// 须先 npm run build（冒烟打的是 dist）。
// 用法：node scripts/smoke-all.mjs            跑全部
//       node scripts/smoke-all.mjs m6 sample  只跑文件名含这些词的
import { spawn, spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SELF = 'smoke-all.mjs'
const PER_SCRIPT_TIMEOUT_MS = 6 * 60_000

// 冒烟脚本共用桩端口与固定的临时目录：两个总入口同时跑必然互相拆台
// （端口被占、临时目录被对方删掉），所以嵌套调用直接跳过。
if (process.env.NM_SMOKE_CHILD) {
  console.log('[smoke-all] 已在总入口内运行，跳过嵌套调用')
  process.exit(0)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const all = readdirSync(`${root}/scripts`)
  .filter((f) => /^smoke-.*\.mjs$/.test(f) && !f.includes('stub') && f !== SELF)
  .sort()
const filters = process.argv.slice(2)
const targets = filters.length ? all.filter((f) => filters.some((k) => f.includes(k))) : all
if (!targets.length) {
  console.error(`没有匹配的冒烟脚本（现有：${all.join(', ')}）`)
  process.exit(2)
}

// 冒烟会再起 dist server 与 LLM 桩，只杀脚本本身会留下占着端口的孤儿进程
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

// 必须串行：带 LLM 的几套共用同一个桩端口。stdio 用 inherit——
// Windows 下管道在子进程 process.exit 时有 libuv 断言崩溃。
let current = null
const run = (file) =>
  new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(process.execPath, [`scripts/${file}`], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NM_SMOKE_CHILD: '1' }
    })
    current = child
    const finish = (code, note = '') => {
      clearTimeout(timer)
      current = null
      resolve({ file, code, ms: Date.now() - t0, note })
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      console.error(`${file} 超时（${PER_SCRIPT_TIMEOUT_MS / 60_000} 分钟），已终止其进程树`)
      // 不等 exit 事件：被强杀的子进程不一定还会回报
      finish(124, '超时')
    }, PER_SCRIPT_TIMEOUT_MS)
    child.on('error', (e) => {
      console.error(`${file} 无法启动：${e.message}`)
      finish(1)
    })
    child.on('exit', (code) => finish(code ?? 1))
  })

process.on('SIGINT', () => {
  if (current) killTree(current.pid)
  process.exit(130)
})

const t0 = Date.now()
const results = []
for (const file of targets) {
  console.log(`\n${'═'.repeat(60)}\n▶ ${file}\n${'═'.repeat(60)}`)
  results.push(await run(file))
}

const sec = (ms) =>
  `${Math.floor(ms / 1000 / 60)}:${String(Math.floor((ms / 1000) % 60)).padStart(2, '0')}`
const failed = results.filter((r) => r.code !== 0)
console.log(
  `\n${'═'.repeat(60)}\n[smoke-all] ${results.length} 套：${results.length - failed.length} 通过 / ${failed.length} 失败，用时 ${sec(Date.now() - t0)}`
)
for (const r of results) {
  console.log(
    `  ${r.code === 0 ? '✓' : '✗'} ${r.file.padEnd(28)} ${sec(r.ms)}${r.note ? `  ${r.note}` : r.code === 0 ? '' : `  exit ${r.code}`}`
  )
}
process.exitCode = failed.length ? 1 : 0
