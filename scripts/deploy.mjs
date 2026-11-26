#!/usr/bin/env node
// v2 部署：构建到 dist.next → 切换产物 → 停旧服务 → detached 拉起 → 探测并校验指纹与 PID。
// 用法：node scripts/deploy.mjs [--data-dir PATH] [--force] [--if-stale]
//   --force     无视进行中的写作任务强行重启（任务会被中断并标 failed）
//   --if-stale  生产 server 已是当前源码的构建（指纹一致）则什么都不做，exit 0
// 仅支持 Windows（taskkill / PowerShell CIM / netstat）。
import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { sourceFingerprint, writeBuildInfo } from './build-info.mjs'
import {
  candidatePorts,
  findProdServer,
  probeHealth,
  readBasePort,
  resolveDataDir,
  serverCheckoutFile,
  serverPidFile
} from './prod-server.mjs'

if (process.platform !== 'win32') {
  console.error('[deploy] 仅支持 Windows')
  process.exit(1)
}

const args = process.argv.slice(2)
const flags = new Set(args)
const root = resolve(import.meta.dirname, '..')
const dataDir = resolveDataDir(args)
const ports = candidatePorts(readBasePort(dataDir))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 失败退出：process.exit 紧跟在几次 fetch 之后会以 libuv 断言崩溃收场，退出码不是 1（AGENTS.md 踩坑 13），
 * 先等句柄收尾再退。
 */
async function exitFail() {
  await sleep(200)
  process.exit(1)
}

/** 未到终态的任务（queued/running/waiting_user）——重启会打断它们 */
async function activeJobs(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/invoke/job:list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"args":[]}',
      signal: AbortSignal.timeout(3000)
    })
    const body = await res.json()
    return (body.result ?? []).filter((j) => !['done', 'failed', 'cancelled'].includes(j.state))
  } catch {
    return []
  }
}

/** 候选端口 → 各自的监听 PID。netstat 一次跑完，不按端口逐个调用 */
function listeners() {
  const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout ?? ''
  const found = new Set()
  for (const line of out.split('\n')) {
    // TCP    0.0.0.0:3910    0.0.0.0:0    LISTENING    12345
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/)
    if (m && ports.includes(Number(m[1]))) found.add(m[2])
  }
  return found
}

/** 各 PID 的命令行（一次 PowerShell 调用）；查不到的（已退出/无权限）不在返回值里 */
function commandLines(pids) {
  if (!pids.length) return new Map()
  const filter = [...pids].map((p) => `ProcessId=${Number(p)}`).join(' OR ')
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8'
  })
  const map = new Map()
  for (const line of (r.stdout ?? '').split('\n')) {
    const at = line.indexOf('\t')
    if (at > 0) map.set(line.slice(0, at).trim(), line.slice(at + 1))
  }
  return map
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const dist = join(root, 'dist')
const next = join(root, 'dist.next')
const entry = join(dist, 'main', 'index.js')
const pidFile = serverPidFile(dataDir)

/**
 * 把构建好的 dist.next 换成 dist。删不掉旧目录（被资源管理器占着等）或整目录改名失败时，
 * 退化为原地覆盖——多出来的旧文件不会被加载，不值得为它让部署失败。
 */
function swapDist() {
  try {
    rmSync(dist, { recursive: true, force: true })
  } catch {
    console.warn('  提示：旧 dist 没能清空，改为原地覆盖')
  }
  try {
    renameSync(next, dist)
  } catch {
    cpSync(next, dist, { recursive: true })
    rmSync(next, { recursive: true, force: true })
  }
}

// ── 0. 现状判断 ───────────────────────────────────────────────────────────────

const live = await findProdServer(dataDir)
const sourceHash = sourceFingerprint(root)
// 只看源码指纹：版本号会随发版变，主进程没改就不该为一串数字重启服务、打断手机端
const stale = !live || live.health.build?.sourceHash !== sourceHash

if (!stale && flags.has('--if-stale')) {
  const h = live.health
  console.log(
    `[deploy] 生产 server 已是当前源码的构建（${h.version} ${h.build?.commit}，指纹 ${h.build?.sourceHash}），无需部署`
  )
  process.exit(0)
}

// 先问再建：有任务在跑时不必白等一轮编译
if (live) {
  const jobs = await activeJobs(live.port)
  if (jobs.length > 0 && !flags.has('--force')) {
    console.error(
      `[deploy] 有 ${jobs.length} 个任务进行中（${jobs.map((j) => j.kind).join('、')}），重启会打断它们。` +
        '等任务结束再部署，或加 --force 强行重启。'
    )
    await exitFail()
  }
}

// ── 1. 构建 ───────────────────────────────────────────────────────────────────

console.log('[deploy] 1/4 构建…')
// 先构建到 dist.next、成功后才换掉 dist：编译失败时磁盘上仍是完整可用的旧产物
rmSync(next, { recursive: true, force: true })
// Node ≥18.20 安全补丁禁止无 shell 直接 spawn .cmd（EINVAL），npm.cmd 不可用；
// tsc（typescript 7）bin 是纯 Node ESM 脚本，直接用当前 node 跑
const build = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json', '--outDir', next],
  { cwd: root, stdio: 'inherit' }
)
if (build.status !== 0 || !existsSync(join(next, 'main', 'index.js'))) {
  rmSync(next, { recursive: true, force: true })
  console.error('[deploy] 构建失败，中止（运行中的旧服务不受影响）')
  await exitFail()
}
const info = writeBuildInfo(root, next)

// ── 2. 停旧服务 ───────────────────────────────────────────────────────────────

console.log('[deploy] 2/4 停止旧服务…')
mkdirSync(dataDir, { recursive: true })
const candidates = new Set(listeners())
try {
  // 端口扫描找不到的情况：旧服务漂到了候选端口之外、或别的进程占了它的端口
  const recorded = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
  if (recorded && alive(recorded)) candidates.add(String(recorded))
} catch {
  /* 没有 PID 文件（老版本部署的首次升级） */
}

const entryLower = entry.toLowerCase()
const stopped = []
for (const [pid, commandLine] of commandLines([...candidates])) {
  // 只认本 checkout 拉起的服务：命令行须含本项目的 dist/main/index.js 绝对路径。
  // 端口被别的项目占用、PID 被复用时一律不杀。
  if (!commandLine?.toLowerCase().includes(entryLower)) {
    console.log(`  跳过 PID ${pid}（不是本 checkout 的服务）`)
    continue
  }
  const r = spawnSync('taskkill', ['/F', '/T', '/PID', pid], { encoding: 'utf8' })
  console.log(
    r.status === 0 ? `  已终止 PID ${pid}` : `  PID ${pid} 终止失败（${(r.stderr ?? '').trim()}）`
  )
  stopped.push(Number(pid))
}
if (stopped.length) {
  // taskkill 返回时端口可能还没释放；不等的话新服务会递增到别的端口，手机端按固定端口就连不上
  for (let i = 0; i < 20 && stopped.some((pid) => alive(pid)); i++) await sleep(250)
}

swapDist()

// ── 3. 拉起新服务 ─────────────────────────────────────────────────────────────

console.log('[deploy] 3/4 拉起新服务…')
const logFile = join(dataDir, 'server.log')
const fd = openSync(logFile, 'a')
const child = spawn(process.execPath, [entry], {
  cwd: root,
  detached: true,
  stdio: ['ignore', fd, fd],
  env: { ...process.env, NM_DATA_DIR: dataDir }
})
child.unref()
let exited = null
child.on('exit', (code) => {
  exited = code
})
writeFileSync(pidFile, `${child.pid}\n`)
writeFileSync(serverCheckoutFile(dataDir), `${root}\n`)
console.log(`  PID ${child.pid}，日志：${logFile}`)

// ── 4. 探测 ───────────────────────────────────────────────────────────────────

console.log('[deploy] 4/4 健康探测…')
let served = null
let foreign = null
for (let i = 0; i < 40 && !served && exited === null; i++) {
  await sleep(500)
  for (const p of ports) {
    const h = await probeHealth(p)
    if (!h) continue
    if (h.pid === child.pid) {
      served = { port: p, ...h }
      break
    }
    foreign = { port: p, ...h }
  }
}

// 没在正确端口上服务的新进程就是残留：占着别的端口、手机端却连不上它，必须收掉
const fail = async (msg) => {
  if (exited === null) {
    child.kill()
    console.error('[deploy] 已终止本次拉起的进程')
  }
  console.error(`[deploy] ${msg}`)
  await exitFail()
}

if (!served) {
  if (exited !== null) await fail(`服务启动后即退出（code ${exited}），请查看 ${logFile}`)
  else if (foreign) {
    await fail(
      `旧实例仍在应答（PID ${foreign.pid}，端口 ${foreign.port}），未被终止；` +
        '新服务多半漂到了别的端口，手机端按固定端口会连不上。'
    )
  } else await fail('探测超时（服务可能仍在启动），请查看 server.log')
}
if (served.port !== ports[0]) {
  await fail(
    `新服务漂到了 ${served.port}（应为 ${ports[0]}）：起始端口被别的进程占着，手机端按固定端口会连不上`
  )
}
if (served.version !== info.version)
  await fail(`版本不符：应答 ${served.version}，本次构建 ${info.version}`)
if (served.build?.sourceHash !== info.sourceHash) {
  await fail(`指纹不符：应答 ${served.build?.sourceHash}，本次构建 ${info.sourceHash}`)
}
console.log(
  `[deploy] 完成：http://127.0.0.1:${served.port}（${info.version} ${info.commit}，指纹 ${info.sourceHash}）`
)
