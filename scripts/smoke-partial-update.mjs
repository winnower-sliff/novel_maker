// save 部分更新语义验证：只传 state 不传 name → name 保留
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from '../dist/main/db.js'
import * as store from '../dist/main/store.js'

const DATA = mkdtempSync(join(tmpdir(), 'nm-patch-smoke-'))
process.env.NM_DATA_DIR = DATA
getDb() // 懒初始化（读 NM_DATA_DIR）
let failed = 0
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}

const book = store.createBook({ title: 'T' })
const line = store.getLine(book.activeLineId)

const c1 = store.saveCharacter({ lineId: line.id, name: '菲林', role: '主角' })
const c2 = store.saveCharacter({ id: c1.id, lineId: line.id, state: { location: '码头' } })
ok('save_character 不传 name → 保留「菲林」', c2?.name === '菲林')
ok('state 已更新', c2?.state?.location === '码头')
ok('role 保留', c2?.role === '主角')

const f1 = store.saveForeshadow({ lineId: line.id, title: '断刀刻痕', synopsis: 'x' })
const f2 = store.saveForeshadow({ id: f1.id, lineId: line.id, synopsis: 'y' })
ok('save_foreshadow 不传 title → 保留「断刀刻痕」', f2?.title === '断刀刻痕')

const card1 = store.saveCard({ lineId: line.id, kind: 'world', title: '雾津港', content: 'a' })
const card2 = store.saveCard({ id: card1.id, lineId: line.id, content: 'b' })
ok('save_card 不传 title → 保留「雾津港」', card2?.title === '雾津港')

rmSync(DATA, { recursive: true, force: true })
console.log(`\n[部分更新冒烟] ${failed ? '失败 ×' + failed : '全部通过'}`)
process.exit(failed ? 1 : 0)
