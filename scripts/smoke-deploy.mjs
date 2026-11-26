// 部署链路冒烟：在临时数据目录上跑 scripts/deploy.mjs——首启 / 构建失败不伤旧服务 / 升级 / 幂等 / 忙时拒绝 / --force。
// 不碰生产：--data-dir 指向临时目录、端口 3979；deploy 只终止「本 checkout 拉起的」进程。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { readBuildInfo, sourceFingerprint } from './build-info.mjs'
import { probeHealth } from './prod-server.mjs'
import { removeTempDir } from './temp-dir.mjs'

const PORT = 3979
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DATA = mkdtempSync(join(tmpdir(), 'nm-deploy-smoke-'))
writeFileSync(join(DATA, 'settings.json'), JSON.stringify({ server: { port: PORT } }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function kill(pid) {
  if (!pid || !alive(pid)) return
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8' })
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250)
}

const deploy = (...flags) =>
  spawnSync(process.execPath, ['scripts/deploy.mjs', '--data-dir', DATA, ...flags], {
    cwd: root,
    encoding: 'utf8'
  })
const output = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`
/** server.pid 里记的 PID；部署没走到拉起那步时文件不存在，返回 NaN（与任何真实 PID 都不相等） */
const recordedPid = () => {
  try {
    return Number.parseInt(readFileSync(join(DATA, 'server.pid'), 'utf8').trim(), 10)
  } catch {
    return Number.NaN
  }
}
/** 改写构建指纹文件：server 每次请求都读它，改完 /api/health 立刻变——用来伪造「产物与源码不一致」 */
const tamperBuildInfo = (patch) => {
  const file = join(root, 'dist', 'build-info.json')
  writeFileSync(file, `${JSON.stringify({ ...readBuildInfo(root), ...patch }, null, 2)}\n`)
}

let failed = 0
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}

let livePid = null
try {
  // 上一轮冒烟被超时强杀时会留下服务（它是 detached 的，不在本轮进程树里）：3979 是冒烟专用端口，直接收掉
  const leftover = await probeHealth(PORT)
  if (leftover) {
    console.log(`  （清理上一轮残留的服务 PID ${leftover.pid}）`)
    await kill(leftover.pid)
  }
  const fp = sourceFingerprint(root)
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

  // ① 首次部署
  const first = deploy()
  ok('首次部署 exit 0', first.status === 0)
  const h1 = await probeHealth(PORT)
  livePid = h1?.pid ?? null
  ok('3979 应答的 PID = server.pid 记录的 PID', h1?.pid === recordedPid())
  ok(
    'health 指纹 = dist/build-info.json = 当前源码指纹',
    h1?.build?.sourceHash === fp && readBuildInfo(root)?.sourceHash === fp
  )
  ok('health 版本 = package.json', h1?.build?.version === version && h1?.version === version)
  ok('记录运行中的 checkout', readFileSync(join(DATA, 'server.checkout'), 'utf8').trim() === root)

  // ② 构建失败：旧服务必须原样继续服务，磁盘上不留半成品
  const broken = join(root, 'src', 'main', '__smoke_broken.ts')
  writeFileSync(broken, "export const broken: number = '不是数字'\n")
  try {
    const bad = deploy()
    ok('源码编译不过时部署失败', bad.status !== 0)
    ok('输出点明「构建失败」', output(bad).includes('构建失败'))
    ok('旧服务仍在原端口应答（同一个进程）', (await probeHealth(PORT))?.pid === h1?.pid)
    ok('没留半成品 dist.next', !existsSync(join(root, 'dist.next')))
    ok('产物未被替换（指纹仍是旧的）', (await probeHealth(PORT))?.build?.sourceHash === fp)
  } finally {
    unlinkSync(broken)
  }

  // ③ 升级：删掉 PID 文件，模拟「老版本部署的服务」（只能靠端口扫描找到它）
  unlinkSync(join(DATA, 'server.pid'))
  tamperBuildInfo({ sourceHash: 'tampered' })
  const upgrade = deploy('--if-stale')
  ok('产物落后时 --if-stale 重新部署', upgrade.status === 0)
  const h2 = await probeHealth(PORT)
  livePid = h2?.pid ?? livePid
  ok('换了新进程', h2?.pid !== h1?.pid && h2?.pid === recordedPid())
  ok('旧进程已终止（靠端口扫描找到的）', !alive(h1?.pid))
  ok('产物恢复为当前源码', h2?.build?.sourceHash === fp)

  // ④ 幂等
  const idle = deploy('--if-stale')
  ok('已是最新时 --if-stale 什么都不做', idle.status === 0 && output(idle).includes('无需部署'))
  ok('进程没有重启', (await probeHealth(PORT))?.pid === h2?.pid)

  // ⑤ 有任务在跑：拒绝重启；--force 才重启，且中断的任务被标 failed
  const created = await fetch(`http://127.0.0.1:${PORT}/api/invoke/book:create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: [{ title: '部署冒烟书' }] })
  }).then((r) => r.json())
  const db = new DatabaseSync(join(DATA, 'novel.db'))
  // 刚建的书是草稿书，服务重启时会被清掉（连任务一起级联删）；这里要验的是任务，先把书转正
  db.prepare('UPDATE books SET draft = 0 WHERE id = ?').run(created.result.id)
  db.prepare(
    'INSERT INTO jobs (id, book_id, line_id, kind, state, step, payload, error, chapter_id, watchdog_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'job-smoke-running',
    created.result.id,
    created.result.activeLineId,
    'write',
    'running',
    'agent',
    '{}',
    '',
    '',
    Date.now() - 60_000,
    Date.now(),
    Date.now()
  )
  db.close()
  tamperBuildInfo({ sourceHash: 'tampered' })
  const busy = deploy()
  ok('有任务进行中时拒绝重启', busy.status !== 0 && output(busy).includes('任务进行中'))
  ok('服务没被动', (await probeHealth(PORT))?.pid === h2?.pid)

  const forced = deploy('--force')
  ok('--force 强行重启', forced.status === 0)
  const h3 = await probeHealth(PORT)
  livePid = h3?.pid ?? livePid
  ok('换了新进程', h3?.pid !== h2?.pid && h3?.pid === recordedPid())
  const after = new DatabaseSync(join(DATA, 'novel.db'), { readOnly: true })
  const row = after.prepare('SELECT state FROM jobs WHERE id = ?').get('job-smoke-running')
  after.close()
  ok(`被中断的任务标为 failed（实际 ${row?.state}）`, row?.state === 'failed')
} catch (e) {
  ok(`异常：${e.message}`, false)
} finally {
  try {
    await kill(recordedPid())
  } catch {
    /* 没有 PID 文件 */
  }
  await kill(livePid)
  await removeTempDir(DATA)
}
console.log(`\n[部署冒烟] ${failed ? `失败 ×${failed}` : '全部通过'}`)
process.exitCode = failed ? 1 : 0
