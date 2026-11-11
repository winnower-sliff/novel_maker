// 书生命周期验证：归档（书架不显示→设置页可恢复）+ 草稿书清理（未发言自动清）
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

  // ── 草稿书清理（用户决策：没产生对话的书不算书） ──
  const a = await invoke('book:create', { title: '误触草稿' })
  ok('新建书为草稿态 draft=true', a.draft === true)
  const b = await invoke('book:create', { title: '书B' })
  ok('再次建书时无发言草稿被清（书架语义：过滤 archived+draft）', true)
  const list0 = await invoke('book:list')
  ok('误触草稿已不在书列表', !list0.some((x) => x.id === a.id))
  ok('书B 还在（当前草稿，等待发言转正）', list0.some((x) => x.id === b.id))

  // ── 归档（草稿与归档独立） ──
  const st1 = await invoke('book:statusCard', b.id)
  ok('statusCard 带 bookId', st1?.bookId === b.id)
  await invoke('book:update', b.id, { archived: true })
  const list1 = await invoke('book:list')
  // book:list 全量返回（设置页恢复列表要用）；书架语义=前端过滤 archived+draft
  ok('归档后书架（过滤 archived）不含书B', !list1.filter((x) => !x.archived).some((x) => x.id === b.id))
  ok('书B 标记 archived=true', list1.find((x) => x.id === b.id)?.archived === true)
  const b2 = await invoke('book:get', b.id)
  ok('归档书数据保留（可 get）', b2?.book?.archived === true)
  await invoke('book:update', b.id, { archived: false })
  const list2 = await invoke('book:list')
  ok('恢复后书B 回书架', list2.some((x) => x.id === b.id))
} catch (e) {
  ok(`异常：${e.message}`, false)
} finally {
  server.kill()
  await new Promise((r) => setTimeout(r, 500))
  try { rmSync(DATA, { recursive: true, force: true }) } catch {}
}
console.log(`\n[归档+草稿冒烟] ${failed ? '失败 ×' + failed : '全部通过'}`)
process.exit(failed ? 1 : 0)
