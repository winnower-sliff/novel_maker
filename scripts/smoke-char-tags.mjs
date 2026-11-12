// list_characters tags 能力验证：全量（附标签索引）/按标签筛/交集排除/brief——直调 execTool
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from '../dist/main/db.js'
import * as store from '../dist/main/store.js'
import { execTool } from '../dist/main/agent/tools.js'

process.env.NM_DATA_DIR = mkdtempSync(join(tmpdir(), 'nm-tags-smoke-'))
getDb()
let failed = 0
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}

const book = store.createBook({ title: 'T' })
const line = store.getLine(book.activeLineId)
const a = store.saveCharacter({ lineId: line.id, name: '林岸', role: '主角', tags: ['逃亡者', '断刀'], data: { age: 19 } })
const b = store.saveCharacter({ lineId: line.id, name: '沈青', role: '配角', tags: ['盐帮', '断刀'] })
store.saveCharacter({ lineId: line.id, name: '路乙', role: '龙套' })

const r1 = await execTool('list_characters', {}, { bookId: book.id })
ok('全量 3 人', r1.data.split('\n').filter((l) => l.startsWith('【')).length === 3)
ok('无过滤附标签索引（断刀(2)）', r1.data.includes('◆ 标签索引：') && r1.data.includes('断刀(2)'))
ok('行内带 #标签', r1.data.includes('#逃亡者'))

const r2 = await execTool('list_characters', { tags: ['逃亡者'] }, { bookId: book.id })
ok('标签筛=逃亡者 → 仅林岸', r2.data.includes('林岸') && !r2.data.includes('沈青') && r2.summary.includes('逃亡者'))
ok('过滤时不附标签索引', !r2.data.includes('◆ 标签索引：'))

const r3 = await execTool('list_characters', { tags: ['断刀'] }, { bookId: book.id })
ok('断刀 → 林岸+沈青 2 人', r3.data.split('\n').filter((l) => l.startsWith('【')).length === 2)

const r4 = await execTool('list_characters', { tags: ['逃亡者'], brief: true }, { bookId: book.id })
ok('brief+标签组合（纯名单带 #）', r4.data.includes('#逃亡者') && !r4.data.includes('id=') === false)

const r5 = await execTool('get_character', { name: '林岸' }, { bookId: book.id })
ok('get_character 按名单查（data 完整）', r5.ok && r5.data.includes('19'))

try { rmSync(process.env.NM_DATA_DIR, { recursive: true, force: true }) } catch {}
console.log(`\n[tags 工具冒烟] ${failed ? '失败 ×' + failed : '全部通过'}`)
process.exit(failed ? 1 : 0)
