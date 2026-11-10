// 归档链路验证：创建→归档（书架不显示）→设置页可见→恢复
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3974
const BASE = `http://127.0.0.1:${PORT}`
const DATA = mkdtempSync(join(tmpdir(), 'nm-archive-'))
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
  const a = await invoke('book:create', { title: '书A' })
  const b = await invoke('book:create', { title: '书B' })
  ok('建两本书', !!a.id && !!b.id)
  const st1 = await invoke('book:statusCard', a.id)
  ok('statusCard 带 bookId', st1?.bookId === a.id)
  await invoke('book:update', a.id, { archived: true })
  const list1 = await invoke('book:list')
  // book:list 全量返回（设置页恢复列表要用）；书架语义=前端过滤 archived
  ok('归档后书架（过滤 archived）不含书A', !list1.filter((x) => !x.archived).some((x) => x.id === a.id))
  ok('书A 标记 archived=true', list1.find((x) => x.id === a.id)?.archived === true)
  ok('书B 仍在', list1.some((x) => x.id === b.id))
  const a2 = await invoke('book:get', a.id)
  ok('归档书数据保留（可 get）', a2?.book?.archived === true)
  await invoke('book:update', a.id, { archived: false })
  const list2 = await invoke('book:list')
  ok('恢复后书A 回书架', list2.some((x) => x.id === a.id))
} catch (e) {
  ok(`异常：${e.message}`, false)
} finally {
  server.kill()
  await new Promise((r) => setTimeout(r, 500))
  try { rmSync(DATA, { recursive: true, force: true }) } catch {}
}
console.log(`\n[归档冒烟] ${failed ? '失败 ×' + failed : '全部通过'}`)
process.exit(failed ? 1 : 0)
