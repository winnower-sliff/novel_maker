// character:save HTTP 链路部分更新验证：不带 name 只改 pinned（zod optional + store 兑底）
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3973
const BASE = `http://127.0.0.1:${PORT}`
const DATA = mkdtempSync(join(tmpdir(), 'nm-char-patch-'))
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
  const b = await invoke('book:create', { title: 'T' })
  const line = b.activeLineId ? { id: b.activeLineId } : null
  if (!line) throw new Error('book 无 activeLineId')
  const c1 = await invoke('character:save', { lineId: line.id, name: '菲林', role: '主角', tags: ['穿越者'] })
  // 不带 name 只翻 pinned —— zod optional 生效 + store 保留 name
  const c2 = await invoke('character:save', { id: c1.id, lineId: line.id, pinned: true })
  ok('HTTP 不带 name 的 save 通过 zod', c2 != null)
  ok('name 保留「菲林」', c2?.name === '菲林')
  ok('pinned 已翻为 true', c2?.pinned === true)
  const c3 = await invoke('character:save', { id: c1.id, lineId: line.id, pinned: false })
  ok('再翻回 false', c3?.pinned === false)
  const f1 = await invoke('foreshadow:save', { lineId: line.id, title: '断刀', detail: 'x' })
  const f2 = await invoke('foreshadow:save', { id: f1.id, lineId: line.id, detail: 'y' })
  ok('foreshadow HTTP 不带 title 通过', f2?.title === '断刀')
} catch (e) {
  ok(`异常：${e.message}`, false)
} finally {
  server.kill()
  await new Promise((r) => setTimeout(r, 500))
  try { rmSync(DATA, { recursive: true, force: true }) } catch {}
}
console.log(`\n[HTTP 部分更新] ${failed ? '失败 ×' + failed : '全部通过'}`)
process.exit(failed ? 1 : 0)
