// 全书导出冒烟：建书→node:sqlite 直插 2 章→GET /api/export/:bookId→zip magic+解包文件数+文件名序号+空书 400
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'

const PORT = 3977
const BASE = `http://127.0.0.1:${PORT}`
const DATA = mkdtempSync(join(tmpdir(), 'nm-export-smoke-'))
writeFileSync(join(DATA, 'settings.json'), JSON.stringify({ server: { port: PORT } }))

const server = spawn(process.execPath, ['dist/main/index.js'], {
  env: { ...process.env, NM_DATA_DIR: DATA },
  stdio: 'inherit',
})
let failed = 0
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}
const invoke = async (channel, ...args) => {
  const r = await fetch(`${BASE}/api/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  })
  const body = await r.json()
  if (!r.ok) throw new Error(`${channel} ${r.status} ${JSON.stringify(body)}`)
  return body.result
}

try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  ok('服务就绪', true)

  const b = await invoke('book:create', { title: '导出测试书' })
  // 直插两章（v2 章由 agent commit_chapter 落库，冒烟绕过 LLM 直接写库）
  const db = new DatabaseSync(join(DATA, 'novel.db'))
  const now = Date.now()
  const ins = db.prepare(
    'INSERT INTO chapters (id, line_id, parent_chapter_id, order_no, title, content, word_count, summary, meta, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  )
  ins.run('ch-1', b.activeLineId, '', 1, '夜港', '码头的雾在半夜最重。'.repeat(10), 100, '', '{}', now, now)
  ins.run('ch-2', b.activeLineId, 'ch-1', 2, '渡海/远航?', '船离岸很远之后。'.repeat(10), 100, '', '{}', now, now)
  db.close()

  const r = await fetch(`${BASE}/api/export/${b.id}`)
  ok('导出 200 zip', r.ok && (r.headers.get('content-type') ?? '') === 'application/zip')
  const buf = new Uint8Array(await r.arrayBuffer())
  ok('PK magic', buf[0] === 0x50 && buf[1] === 0x4b)
  const files = unzipSync(buf)
  const names = Object.keys(files)
  ok(`解包 2 个文件（实际 ${names.length}）`, names.length === 2)
  ok('文件名序号补零', names.includes('0001-夜港.txt'))
  ok('非法字符被替换', names.some((n) => n.startsWith('0002-') && n.endsWith('.txt') && !/[\\/:*?"<>|]/.test(n)))
  ok('正文完整', new TextDecoder().decode(files['0001-夜港.txt']).includes('码头的雾'))

  const r404 = await fetch(`${BASE}/api/export/not-exist`)
  ok('不存在的书 404', r404.status === 404)

  const b2 = await invoke('book:create', { title: '空书' })
  const r400 = await fetch(`${BASE}/api/export/${b2.id}`)
  ok('空书 400', r400.status === 400)
} catch (e) {
  ok(`异常：${e.message}`, false)
} finally {
  server.kill()
  await new Promise((r) => setTimeout(r, 500))
  try {
    rmSync(DATA, { recursive: true, force: true })
  } catch {}
}
console.log(`\n[导出冒烟] ${failed ? `失败 ×${failed}` : '全部通过'}`)
process.exit(failed ? 1 : 0)

