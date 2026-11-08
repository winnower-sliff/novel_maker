// 新工具/新参数进程内快测：list_lines/get_character/search_project 章节域/read_chapter 定位/brief
import { execTool } from '../dist/main/agent/tools.js'

const ctx = { bookId: 'a68b91b9-3a82-41ac-8701-f7d20680cb8c' }
let pass = 0
let fail = 0
const t = (name, r, want) => {
  const ok = want(r)
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (ok) pass++
  else {
    fail++
    console.log('   got:', r.summary, '|', (r.data || '').slice(0, 150))
  }
}

const lines = execTool('list_lines', {}, ctx)
t('list_lines 列出线', lines, (r) => r.ok && r.data.includes('★当前'))

const chars = execTool('list_characters', { brief: true }, ctx)
t('list_characters brief 名单', chars, (r) => r.ok && r.summary.includes('仅名单'))
const first = chars.data.match(/id=([0-9a-f-]{36})/)?.[1]
if (first) {
  const one = execTool('get_character', { characterId: first }, ctx)
  t('get_character 详情含人设卡', one, (r) => r.ok && r.data.includes('〔人设卡〕'))
}
const byName = execTool('get_character', { name: '菲林' }, ctx)
t('get_character 名字兜底', byName, (r) => r.ok && r.data.includes('菲林'))

const sp = execTool('search_project', { q: '南屿', scope: 'chapters' }, ctx)
t('search_project 章节域', sp, (r) => r.ok && (r.summary.includes('0 条') || r.data.includes('[章节]')))
const spAll = execTool('search_project', { q: '林岸' }, ctx)
t('search_project 全板块', spAll, (r) => r.ok)

const ch = execTool('list_chapters', { brief: true }, ctx)
t('list_chapters brief', ch, (r) => r.ok && r.summary.includes('仅标题'))
const chId = ch.data.match(/id=([0-9a-f-]{36})/)?.[1]
if (chId) {
  const rq = execTool('read_chapter', { chapterId: chId, q: '的' }, ctx)
  t('read_chapter q 定位', rq, (r) => r.ok && r.data.includes('命中处附近'))
  const rf = execTool('read_chapter', { chapterId: chId, from: 100 }, ctx)
  t('read_chapter from 起点', rf, (r) => r.ok && r.data.includes('从第 101 字起'))
}

console.log(`\n[工具快测] ${fail ? '失败' : '全部通过'} ${pass} 过 / ${fail} 败`)
process.exit(fail ? 1 : 0)
