// 分叉点保护冒烟（直调 store/execTool，无需模型）：
// 分叉点章不可删 / 分叉点丢失时子线不丢祖先章 / 普通末章照常可删
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NM_DATA_DIR = mkdtempSync(join(tmpdir(), 'nm-fork-smoke-'))

const { getDb } = await import('../dist/main/db.js')
const store = await import('../dist/main/store.js')
const { execTool } = await import('../dist/main/agent/tools.js')

let failed = 0
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}
const addChapter = (lineId, parentChapterId, title) =>
  store.insertChapter({
    lineId,
    parentChapterId,
    title,
    content: `${title}的正文。`,
    summary: '',
    meta: {}
  })
const titles = (lineId) => store.effectiveChapters(lineId).map((c) => c.title)
const backupCount = () =>
  readdirSync(process.env.NM_DATA_DIR).filter((f) => f.startsWith('backup-')).length

try {
  getDb()
  const book = store.createBook({ title: '分叉测试书' })
  const main = book.activeLineId
  const ch1 = addChapter(main, '', '起雾')
  const ch2 = addChapter(main, ch1.id, '登船')
  const ch3 = addChapter(main, ch2.id, '夜谈')

  const fork = store.forkLine(book.id, ch3.id, '复仇线', '')
  ok('开新线记录分叉点序号（forkOrder=3）', fork.forkOrder === 3)
  ok('新线继承全部祖先章（3 章）', titles(fork.id).join() === '起雾,登船,夜谈')

  // ① 分叉点章不可删（工具层：快照之前就拦下）。工具作用于书的激活线，先切回主线
  store.activateLine(book.id, main)
  const backupsBefore = backupCount()
  const refused = execTool('delete_last_chapter', {}, { bookId: book.id })
  ok('删分叉点章被拒', refused.ok === false)
  ok(
    '拒绝文案点名分叉线',
    String(refused.data).includes('分叉线「复仇线」') && String(refused.data).includes('夜谈')
  )
  ok('主线仍是 3 章', store.listChapters(main).length === 3)
  ok('被拒时没有留下快照', backupCount() === backupsBefore)

  // ② store 层兜底（绕过工具直接调也删不掉）
  let threw = ''
  try {
    store.deleteLastChapter(main)
  } catch (e) {
    threw = e.message
  }
  ok('store 层同样拒绝', threw.includes('分叉线'))
  ok('主线仍 3 章', store.listChapters(main).length === 3)

  // ③ 分叉点章因故丢失（历史遗留/外部改动）：子线保住更早的祖先章
  getDb().prepare('DELETE FROM chapter_versions WHERE chapter_id = ?').run(ch3.id)
  getDb().prepare('DELETE FROM chapters WHERE id = ?').run(ch3.id)
  ok('分叉点丢失后仍保住更早祖先章（起雾,登船）', titles(fork.id).join() === '起雾,登船')
  addChapter(fork.id, ch2.id, '寻仇')
  ok('子线新章接在祖先章之后', titles(fork.id).join() === '起雾,登船,寻仇')

  // ④ 旧库线没有记录序号：退回旧行为（只显示本线章），不崩
  getDb().prepare('UPDATE lines SET fork_order = -1 WHERE id = ?').run(fork.id)
  ok('无序号记录时只显示本线章', titles(fork.id).join() === '寻仇')

  // ⑤ 不是任何分叉点起点的末章照常可删
  const book2 = store.createBook({ title: '普通书' })
  addChapter(book2.activeLineId, '', '一')
  addChapter(book2.activeLineId, '', '二')
  const removed = execTool('delete_last_chapter', {}, { bookId: book2.id })
  ok('普通末章可删', removed.ok === true && String(removed.summary).includes('撤回《二》'))
  ok('删后剩 1 章', store.listChapters(book2.activeLineId).length === 1)
} catch (e) {
  ok(`异常：${e.message}`, false)
} finally {
  try {
    rmSync(process.env.NM_DATA_DIR, { recursive: true, force: true })
  } catch {
    // Windows 上 sqlite 句柄可能未释放
  }
}

console.log(`\n[分叉点冒烟] ${failed ? '失败' : '全部通过'}${failed ? ` ×${failed}` : ''}`)
process.exit(failed ? 1 : 0)
