#!/usr/bin/env node
// v2 部署脚本：build → 杀旧服务（按端口）→ detached 拉起新服务 → 健康探测。
// 用法：node scripts/deploy.mjs [--port N] [--data-dir PATH]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
function argValue(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const root = resolve(import.meta.dirname, '..')

// 与 src/main/paths.ts 保持一致的数据目录解析
const dataDir =
  argValue('--data-dir') ||
  process.env.NM_DATA_DIR ||
  (process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'novel-maker-v2')
    : join(homedir(), '.novel-maker-v2'))

// 端口：--port > settings.json > 3910（server.port 是初始端口，端口被占时服务会递增；
// 部署前旧进程一般还占着 settings 记录的端口，找不到再扫描 port..port+10）
function readPort() {
  const explicit = argValue('--port')
  if (explicit) return Number.parseInt(explicit, 10)
  try {
    const settings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
    if (settings?.server?.port) return settings.server.port
  } catch {
    /* 首次部署无 settings.json */
  }
  return 3910
}

function pidsListeningOn(port) {
  const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout ?? ''
  const pids = new Set()
  for (const line of out.split('\n')) {
    // TCP    0.0.0.0:3910    0.0.0.0:0    LISTENING    12345
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/)
    if (m && Number(m[1]) === port) pids.add(m[2])
  }
  return [...pids]
}

function killPids(pids) {
  for (const pid of pids) {
    const r = spawnSync('taskkill', ['/F', '/T', '/PID', pid], { encoding: 'utf8' })
    console.log(r.status === 0 ? `  已终止 PID ${pid}` : `  PID ${pid} 终止失败（可能已退出）`)
  }
}

console.log('[deploy] 1/4 构建…')
const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
})
if (build.status !== 0) {
  console.error('[deploy] 构建失败，中止')
  process.exit(1)
}

const entry = join(root, 'dist', 'main', 'index.js')
if (!existsSync(entry)) {
  console.error(`[deploy] 未找到产物 ${entry}`)
  process.exit(1)
}

console.log('[deploy] 2/4 停止旧服务…')
const basePort = readPort()
for (let p = basePort; p < basePort + 10; p++) killPids(pidsListeningOn(p))

console.log('[deploy] 3/4 拉起新服务…')
const logFile = join(dataDir, 'server.log')
const fd = openSync(logFile, 'a')
const child = spawn(process.execPath, [entry], {
  cwd: root,
  detached: true,
  stdio: ['ignore', fd, fd],
  env: { ...process.env, NM_DATA_DIR: dataDir },
})
child.unref()
console.log(`  PID ${child.pid}，日志：${logFile}`)

console.log('[deploy] 4/4 健康探测…')
let ok = false
for (let i = 0; i < 20 && !ok; i++) {
  await new Promise((r) => setTimeout(r, 500))
  for (let p = basePort; p < basePort + 10 && !ok; p++) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/api/health`)
      if (res.ok) {
        ok = true
        console.log(`[deploy] 完成：http://127.0.0.1:${p}/api/health OK`)
      }
    } catch {
      /* 未就绪，继续等 */
    }
  }
}
if (!ok) {
  console.error('[deploy] 探测超时（服务可能仍在启动），请查看 server.log')
  process.exit(1)
}
