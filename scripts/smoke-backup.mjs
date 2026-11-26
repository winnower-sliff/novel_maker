// 备份冒烟：每日备份 / 保留策略 / 进程内恢复 / 坏配置保全 / 升级前快照（无 LLM，端口 3983）
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { removeTempDir, stopChild } from './temp-dir.mjs'

const root = process.cwd()
const PORT = 3983
const BASE = `http://127.0.0.1:${PORT}`
const DATA = mkdtempSync(join(tmpdir(), 'nm-backup-smoke-'))
const OLD_DIR = mkdtempSync(join(tmpdir(), 'nm-backup-old-'))
const CFG_DIR = mkdtempSync(join(tmpdir(), 'nm-backup-cfg-'))
const FRESH_DIR = mkdtempSync(join(tmpdir(), 'nm-backup-fresh-'))
writeFileSync(join(DATA, 'settings.json'), JSON.stringify({ server: { port: PORT } }))
process.env.NM_DATA_DIR = DATA

const url = (file) => pathToFileURL(join(root, 'dist/main', file)).href
const dbMod = await import(url('db.js'))
const { dailyBackup } = await import(url('backup.js'))
const store = await import(url('store.js'))

const server = spawn(process.execPath, [join(root, 'dist/main/index.js')], {
  env: { ...process.env, NM_DATA_DIR: DATA },
  stdio: 'inherit'
})

let failed = 0
let passed = 0
const ok = (name, cond) => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const invoke = async (channel, ...args) => {
  const r = await fetch(`${BASE}/api/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args })
  })
  const body = await r.json()
  if (!r.ok) throw new Error(`${channel} ${r.status} ${JSON.stringify(body)}`)
  return body.result
}
const waitReady = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error('server 未就绪')
}
const filesOf = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
const dayStamp = (offsetDays) => {
  const d = new Date()
  d.setDate(d.getDate() - offsetDays)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}
/** 在独立子进程里跑一段代码（避免本进程的模块缓存干扰），收集它打印的 JSON 行 */
const child = (code) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
const jsonLines = (out) =>
  (out ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
const tryRestore = async (name) => {
  try {
    await invoke('backup:restore', name)
    return ''
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

try {
  await waitReady()
  ok('服务就绪', true)

  // ① 空库
  ok('空库不做每日备份', (await dailyBackup()) === null)
  ok('空库无备份文件', !filesOf(DATA).some((f) => f.startsWith('backup-')))

  // ② 建书 + 手动备份
  const book = store.createBook({ title: '备份测试书' })
  dbMod.getDb().prepare('UPDATE books SET draft=0').run()
  dbMod.closeDb()
  const m1 = await invoke('backup:create')
  ok('手动备份落盘（tag=manual）', m1?.tag === 'manual' && existsSync(join(DATA, m1.name)))

  // ③ 每日备份（须早于 server 启动 15 秒后的自动备份）
  const gz = await dailyBackup()
  dbMod.closeDb()
  ok('每日备份产出 .db.gz', typeof gz === 'string' && gz.endsWith('.db.gz') && existsSync(gz))
  ok('每日备份的纯 db 已删', typeof gz === 'string' && !existsSync(gz.slice(0, -3)))
  ok('当天不重复备份', (await dailyBackup()) === null)

  // ④ 操作快照保留上限
  for (let i = 0; i < 35; i++) {
    writeFileSync(join(DATA, `backup-del-card-20250101-00${String(i).padStart(2, '0')}00.db`), 'x')
  }
  writeFileSync(join(DATA, 'backup-manual-20200101-000000.db'), 'x')
  await invoke('backup:create')
  const dels = filesOf(DATA).filter((f) => f.startsWith('backup-del-card-20250101-'))
  ok(`删除前快照只留最新 30 份（剩 ${dels.length}）`, dels.length === 30)
  ok('手动备份不被自动清理', existsSync(join(DATA, 'backup-manual-20200101-000000.db')))

  // ⑤ 每日备份保留策略：近 7 天全留，更早的每周留 1 份
  const dailyNames = []
  for (let i = 0; i <= 20; i++) {
    const name = `backup-daily-${dayStamp(i)}-120000.db.gz`
    dailyNames.push(name)
    writeFileSync(join(DATA, name), 'x')
  }
  await invoke('backup:create')
  const after = new Set(filesOf(DATA))
  const recentKept = dailyNames.slice(0, 7).filter((n) => after.has(n)).length
  const olderKept = dailyNames.slice(7).filter((n) => after.has(n)).length
  ok(`近 7 天的每日备份全留（${recentKept}/7）`, recentKept === 7)
  ok(`更早的每周留 1 份（14 份剩 ${olderKept}）`, olderKept >= 1 && olderKept <= 3)

  // ⑥ 恢复到某个时点的备份
  const ch = store.insertChapter({
    lineId: book.activeLineId,
    parentChapterId: '',
    title: '第一章',
    content: '初稿内容',
    summary: '',
    meta: {}
  })
  dbMod.closeDb()
  const s1 = await invoke('backup:create')
  store.replaceChapterContent(ch.id, '改过的内容')
  dbMod.closeDb()
  ok('恢复前：章内容是改过的', (await invoke('chapter:get', ch.id))?.content === '改过的内容')
  const r1 = await invoke('backup:restore', s1.name)
  ok(
    '恢复返回并留了恢复前快照',
    typeof r1?.safeguard === 'string' &&
      r1.safeguard.startsWith('backup-pre-restore-') &&
      existsSync(join(DATA, r1.safeguard))
  )
  ok('恢复后：章内容回到备份时点', (await invoke('chapter:get', ch.id))?.content === '初稿内容')
  ok(
    '备份清单含恢复前快照',
    (await invoke('backup:list')).some((e) => e.tag === 'pre-restore')
  )

  // ⑦ 恢复到更早的备份（那时还没有章）
  await invoke('backup:restore', m1.name)
  ok('恢复到更早备份：章已不存在', (await invoke('chapter:get', ch.id)) === null)
  ok('恢复到更早备份：本线章数为 0', store.listChapters(book.activeLineId).length === 0)
  dbMod.closeDb()

  // ⑧ 非法输入
  const e1 = await tryRestore('../x.db')
  ok('非法文件名被拒', e1.includes('400') && e1.includes('不合法'))
  const e2 = await tryRestore('backup-manual-19990101-000000.db')
  ok('不存在的备份被拒', e2.includes('400') && e2.includes('找不到'))

  // ⑨ settings.json 损坏：改名保全，不被默认值覆盖
  writeFileSync(join(CFG_DIR, 'settings.json'), '{ not json')
  const cfgRun = child(`
process.env.NM_DATA_DIR = ${JSON.stringify(CFG_DIR)}
const { readdirSync } = await import('node:fs')
const cfg = await import(${JSON.stringify(url('config.js'))})
cfg.loadServerConfig()
console.log(JSON.stringify({ files: readdirSync(process.env.NM_DATA_DIR) }))
cfg.saveSettings({})
console.log(JSON.stringify({ files: readdirSync(process.env.NM_DATA_DIR) }))
`)
  const [cfg1, cfg2] = jsonLines(cfgRun.stdout)
  ok(
    '坏配置被改名保全',
    Array.isArray(cfg1?.files) &&
      cfg1.files.some((f) => f.startsWith('settings.json.corrupt-')) &&
      !cfg1.files.includes('settings.json')
  )
  ok(
    '之后保存设置重新写出，无临时文件残留',
    Array.isArray(cfg2?.files) &&
      cfg2.files.includes('settings.json') &&
      !cfg2.files.some((f) => f.endsWith('.tmp'))
  )

  // ⑩ 结构升级前自动留快照
  const old = new DatabaseSync(join(OLD_DIR, 'novel.db'))
  old.exec('CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT)')
  old.close()
  const probe = (dir) =>
    child(`
process.env.NM_DATA_DIR = ${JSON.stringify(dir)}
const { readdirSync } = await import('node:fs')
const m = await import(${JSON.stringify(url('db.js'))})
const d = m.getDb()
console.log(JSON.stringify({ files: readdirSync(process.env.NM_DATA_DIR), version: d.prepare('PRAGMA user_version').get() }))
`)
  const pOld = jsonLines(probe(OLD_DIR).stdout)[0]
  ok(
    '旧库升级前自动留快照',
    Array.isArray(pOld?.files) && pOld.files.some((f) => f.startsWith('backup-pre-migrate-'))
  )
  ok('升级后记录结构版本号', (pOld?.version?.user_version ?? pOld?.version) === 1)
  const pFresh = jsonLines(probe(FRESH_DIR).stdout)[0]
  ok(
    '全新库不留升级前快照',
    Array.isArray(pFresh?.files) && !pFresh.files.some((f) => f.startsWith('backup-pre-migrate-'))
  )
} catch (e) {
  ok(`异常：${e instanceof Error ? e.message : String(e)}`, false)
} finally {
  await stopChild(server)
  try {
    dbMod.closeDb()
  } catch {}
  await Promise.all([DATA, OLD_DIR, CFG_DIR, FRESH_DIR].map((dir) => removeTempDir(dir)))
}
console.log(`\n[备份冒烟] ${passed} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0
