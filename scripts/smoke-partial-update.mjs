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

// 新库直建 data/tags 列（旧库 RENAME 路径由生产迁移验证）
const cols = getDb().prepare("PRAGMA table_info('characters')").all().map((c) => c.name)
ok('characters 平铺列 data+tags（无 card）', cols.includes('data') && cols.includes('tags') && !cols.includes('card'))

const c1 = store.saveCharacter({ lineId: line.id, name: '菲林', role: '主角' })
const c2 = store.saveCharacter({ id: c1.id, lineId: line.id, state: { location: '码头' } })
ok('save_character 不传 name → 保留「菲林」', c2?.name === '菲林')
ok('state 已更新', c2?.state?.location === '码头')
ok('role 保留', c2?.role === '主角')

// ── 人设三件套（tags 增量 / data 浅合并 / 与 state 互不干扰） ──
const c3 = store.saveCharacter({
  lineId: line.id,
  name: '林岸',
  tags: ['逃亡者', '断刀'],
  data: { age: 19, trait: '隐忍' }
})
ok('建档带三件套（tags+data）', c3?.tags.length === 2 && c3?.data?.age === 19)
const c4 = store.updateCharacterTags(c3.id, { add: ['盐帮悬赏'], delete: ['断刀'] })
ok('tags 增量（add+delete）', JSON.stringify(c4?.tags) === JSON.stringify(['逃亡者', '盐帮悬赏']))
const c5 = store.updateCharacterData(c3.id, { location: '蔗糖舱' })
ok('data 浅合并（兄弟键 age 保留）', c5?.data?.location === '蔗糖舱' && c5?.data?.age === 19 && c5?.data?.trait === '隐忍')
ok('data 合并不碰 state/tags', c5?.state && Object.keys(c5.state).length === 0 && c5?.tags.length === 2)
const c6 = store.saveCharacter({ id: c3.id, lineId: line.id, state: { mood: '紧绷' } })
ok('save_character 改 state 不覆盖 data/tags', c6?.data?.age === 19 && c6?.tags.length === 2 && c6?.state?.mood === '紧绷')

const f1 = store.saveForeshadow({ lineId: line.id, title: '断刀刻痕', synopsis: 'x' })
const f2 = store.saveForeshadow({ id: f1.id, lineId: line.id, synopsis: 'y' })
ok('save_foreshadow 不传 title → 保留「断刀刻痕」', f2?.title === '断刀刻痕')

const card1 = store.saveCard({ lineId: line.id, kind: 'world', title: '雾津港', content: 'a' })
const card2 = store.saveCard({ id: card1.id, lineId: line.id, content: 'b' })
ok('save_card 不传 title → 保留「雾津港」', card2?.title === '雾津港')

try {
  rmSync(DATA, { recursive: true, force: true })
} catch {
  // Windows 下 sqlite 句柄未释放时删不掉，留临时目录无害
}
console.log(`\n[部分更新冒烟] ${failed ? '失败 ×' + failed : '全部通过'}`)
process.exit(failed ? 1 : 0)
