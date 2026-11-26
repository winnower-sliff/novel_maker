// 分叉点保护冒烟（直调 store/execTool，无需模型）：
// 分叉点章不可删 / 分叉点丢失时子线不丢祖先章 / 普通末章照常可删 / 嵌套分叉的有效章按位置截
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from './temp-dir.mjs'

process.env.NM_DATA_DIR = mkdtempSync(join(tmpdir(), 'nm-fork-smoke-'))

const { closeDb, getDb } = await import('../dist/main/db.js')
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

  // ── 嵌套分叉：有效章按分叉点在它所在线里的位置截 ──
  // 回归：各线章序号从 1 重排，曾拿子线的序号去过滤祖先章，祖先线中间的章被整段丢掉
  const book3 = store.createBook({ title: '嵌套分叉书' })
  const main3 = book3.activeLineId
  const a = []
  for (let i = 1; i <= 10; i++) a.push(addChapter(main3, a.at(-1)?.id ?? '', `A${i}`))
  const lineB = store.forkLine(book3.id, a[5].id, '乙线', '').id
  const b1 = addChapter(lineB, a[5].id, 'B1')
  const b2 = addChapter(lineB, b1.id, 'B2')
  const lineC = store.forkLine(book3.id, b2.id, '丙线', '').id
  const c1 = addChapter(lineC, b2.id, 'C1')
  const idSeq = (lineId) => store.effectiveChapters(lineId).map((c) => c.id)
  const seq = (...chs) => chs.map((c) => c.id)
  ok(
    '嵌套① 乙线（分叉于 A6 后）= A1–A6 + B1、B2',
    idSeq(lineB).join() === seq(...a.slice(0, 6), b1, b2).join()
  )
  ok(
    '嵌套① 丙线（分叉于乙线 B2 后）= A1–A6 + B1、B2 + C1',
    idSeq(lineC).join() === seq(...a.slice(0, 6), b1, b2, c1).join()
  )
  const lineD = store.forkLine(book3.id, a[3].id, '丁线', '').id
  const d1 = addChapter(lineD, a[3].id, 'D1')
  ok(
    '嵌套② 分叉点是继承来的 A4 = A1–A4 + 自己的章',
    idSeq(lineD).join() === seq(...a.slice(0, 4), d1).join()
  )
  const lineF = store.forkLine(book3.id, a[1].id, '戊线', '').id
  ok('嵌套② 隔两代的祖先章 A2 = A1、A2', idSeq(lineF).join() === seq(...a.slice(0, 2)).join())

  // ③ 分叉点章不在了的兜底（删章接口会拦，只能直接删行模拟历史遗留）：
  // 按建线时记的序号切，且只切直接父线自己的章；继承来的祖先章全部保留
  const lineE = store.forkLine(book3.id, b1.id, '己线', '').id
  const e1 = addChapter(lineE, b1.id, 'E1')
  const dropChapter = (ch) => {
    getDb().prepare('DELETE FROM chapter_versions WHERE chapter_id = ?').run(ch.id)
    getDb().prepare('DELETE FROM chapters WHERE id = ?').run(ch.id)
  }
  dropChapter(b1)
  ok(
    '嵌套③ 己线的分叉点章 B1 丢了：保住继承的 A1–A6 + 自己的章',
    idSeq(lineE).join() === seq(...a.slice(0, 6), e1).join()
  )
  dropChapter(a[5])
  ok(
    '嵌套③ 乙线的分叉点章 A6 丢了：A1–A5（分叉点之后的 A7–A10 不算）+ B2',
    idSeq(lineB).join() === seq(...a.slice(0, 5), b2).join()
  )
  ok(
    '嵌套③ 再往下的丙线跟着对：A1–A5 + B2 + C1',
    idSeq(lineC).join() === seq(...a.slice(0, 5), b2, c1).join()
  )
} catch (e) {
  ok(`异常：${e.message}`, false)
} finally {
  // 本进程开着的 sqlite 句柄不关，目录删不掉
  closeDb()
  await removeTempDir(process.env.NM_DATA_DIR)
}

console.log(`\n[分叉点冒烟] ${failed ? '失败' : '全部通过'}${failed ? ` ×${failed}` : ''}`)
process.exitCode = failed ? 1 : 0
