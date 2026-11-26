import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  Book,
  Card,
  CardKind,
  Chapter,
  ChapterMeta,
  Character,
  CharacterState,
  ChatMessageRow,
  Foreshadow,
  ForeshadowStatus,
  Job,
  JobKind,
  JobPayload,
  JobState,
  JobStep,
  MemoryBlock,
  MemoryKind,
  SampleInfo,
  StoryLine
} from '../shared/types.js'
import { getDb, snapshotDb } from './db.js'
import { parseSampleSections } from './sampleParse.js'

/** 行→对象映射（snake_case 列 ↔ camelCase 字段） */

function rowToBook(r: Record<string, unknown>): Book {
  return {
    id: r.id as string,
    title: r.title as string,
    intro: (r.intro as string) ?? '',
    genre: (r.genre as string) ?? '',
    styleName: (r.style_name as string) ?? '',
    styleSample: (r.style_sample as string) ?? '',
    styleNotes: (r.style_notes as string) ?? '',
    styleSampleSource: (r.style_sample_source as string) ?? '',
    sampleSources: JSON.parse((r.sample_sources as string) || '[]') as string[],
    targetWords: (r.target_words as number) ?? 2000,
    redlines: JSON.parse((r.redlines as string) || '[]') as string[],
    positiveWords: JSON.parse((r.positive_words as string) || '[]') as string[],
    negativeWords: JSON.parse((r.negative_words as string) || '[]') as string[],
    planMode: Boolean(r.plan_mode),
    draft: Boolean(r.draft),
    activeLineId: (r.active_line_id as string) ?? '',
    archived: Boolean(r.archived),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

function rowToLine(r: Record<string, unknown>): StoryLine {
  return {
    id: r.id as string,
    bookId: r.book_id as string,
    parentLineId: (r.parent_line_id as string) ?? '',
    forkChapterId: (r.fork_chapter_id as string) ?? '',
    forkOrder: Number(r.fork_order ?? -1),
    name: r.name as string,
    note: (r.note as string) ?? '',
    createdAt: r.created_at as number
  }
}

function rowToChapter(r: Record<string, unknown>): Chapter {
  return {
    id: r.id as string,
    lineId: r.line_id as string,
    parentChapterId: (r.parent_chapter_id as string) ?? '',
    orderNo: r.order_no as number,
    title: (r.title as string) ?? '',
    content: (r.content as string) ?? '',
    wordCount: (r.word_count as number) ?? 0,
    summary: (r.summary as string) ?? '',
    meta: JSON.parse((r.meta as string) || '{}') as ChapterMeta,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

function rowToCard(r: Record<string, unknown>): Card {
  return {
    id: r.id as string,
    bookId: r.book_id as string,
    lineId: r.line_id as string,
    kind: (r.kind as CardKind) ?? 'custom',
    title: r.title as string,
    readerText: (r.reader_text as string) ?? '',
    authorText: (r.author_text as string) ?? '',
    revealPlan: (r.reveal_plan as string) ?? '',
    data: JSON.parse((r.data as string) || '{}') as Record<string, unknown>,
    pinned: Boolean(r.pinned),
    tags: JSON.parse((r.tags as string) || '[]') as string[],
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

function rowToCharacter(r: Record<string, unknown>): Character {
  return {
    id: r.id as string,
    bookId: r.book_id as string,
    lineId: r.line_id as string,
    name: r.name as string,
    role: (r.role as string) ?? '',
    data: JSON.parse((r.data as string) || '{}') as Record<string, unknown>,
    state: JSON.parse((r.state as string) || '{}') as CharacterState,
    relations: JSON.parse((r.relations as string) || '[]') as Character['relations'],
    pinned: Boolean(r.pinned),
    tags: JSON.parse((r.tags as string) || '[]') as string[],
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

function rowToForeshadow(r: Record<string, unknown>): Foreshadow {
  return {
    id: r.id as string,
    bookId: r.book_id as string,
    lineId: r.line_id as string,
    title: r.title as string,
    detail: (r.detail as string) ?? '',
    plantedChapterId: (r.planted_chapter_id as string) ?? '',
    plannedChapterId: (r.planned_chapter_id as string) ?? '',
    resolvedChapterId: (r.resolved_chapter_id as string) ?? '',
    status: (r.status as ForeshadowStatus) ?? 'open',
    priority: (r.priority as number) ?? 1,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

function rowToMemory(r: Record<string, unknown>): MemoryBlock {
  return {
    id: r.id as string,
    lineId: r.line_id as string,
    fromOrder: r.from_order as number,
    toOrder: r.to_order as number,
    content: r.content as string,
    kind: r.kind === 'running' ? 'running' : 'legacy',
    lastChapterId: (r.last_chapter_id as string) ?? '',
    createdAt: r.created_at as number
  }
}

function rowToMessage(r: Record<string, unknown>): ChatMessageRow {
  return {
    id: r.id as string,
    bookId: r.book_id as string,
    chapterId: (r.chapter_id as string) ?? '',
    role: r.role as 'user' | 'assistant',
    content: (r.content as string) ?? '',
    meta: JSON.parse((r.meta as string) || '{}') as Record<string, unknown>,
    createdAt: r.created_at as number
  }
}

function rowToJob(r: Record<string, unknown>): Job {
  return {
    id: r.id as string,
    bookId: r.book_id as string,
    lineId: r.line_id as string,
    kind: r.kind as JobKind,
    state: r.state as JobState,
    step: (r.step as JobStep) ?? '',
    payload: JSON.parse((r.payload as string) || '{}') as JobPayload,
    error: (r.error as string) ?? '',
    chapterId: (r.chapter_id as string) ?? '',
    watchdogAt: (r.watchdog_at as number) ?? 0,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

export function countWords(text: string): number {
  return text.replace(/\s/g, '').length
}

// ── books ────────────────────────────────────────────────────────────────────

export function createBook(input: { title: string; genre?: string; targetWords?: number }): Book {
  const db = getDb()
  const now = Date.now()
  const bookId = randomUUID()
  const lineId = randomUUID()
  // 顺带清掉历史误触留下的草稿书（无用户发言的 draft 书）
  purgeDraftBooks()
  db.prepare(
    `INSERT INTO books (id, title, genre, target_words, redlines, active_line_id, draft, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', ?, 1, ?, ?)`
  ).run(bookId, input.title, input.genre ?? '', input.targetWords ?? 2000, lineId, now, now)
  db.prepare(`INSERT INTO lines (id, book_id, name, created_at) VALUES (?, ?, '主线', ?)`).run(
    lineId,
    bookId,
    now
  )
  return getBook(bookId) as Book
}

/** 清掉从未有过用户发言的草稿书（级联删空设定；误触「开新书」不留痕） */
export function purgeDraftBooks(): number {
  const db = getDb()
  return Number(
    db
      .prepare(
        `DELETE FROM books WHERE draft = 1 AND id NOT IN
         (SELECT DISTINCT book_id FROM messages WHERE role = 'user')`
      )
      .run().changes
  )
}

export function getBook(id: string): Book | null {
  const r = getDb().prepare('SELECT * FROM books WHERE id = ?').get(id)
  return r ? rowToBook(r) : null
}

export function listBooks(): Book[] {
  return (
    getDb().prepare('SELECT * FROM books ORDER BY updated_at DESC').all() as Record<
      string,
      unknown
    >[]
  ).map(rowToBook)
}

export interface BookPatch {
  title?: string
  intro?: string
  genre?: string
  styleName?: string
  styleSample?: string
  styleNotes?: string
  styleSampleSource?: string
  sampleSources?: string[]
  targetWords?: number
  redlines?: string[]
  positiveWords?: string[]
  negativeWords?: string[]
  planMode?: boolean
  archived?: boolean
}

export function updateBook(id: string, patch: BookPatch): Book | null {
  const set: string[] = []
  const vals: SQLInputValue[] = []
  const push = (col: string, v: SQLInputValue): void => {
    set.push(`${col} = ?`)
    vals.push(v)
  }
  if (patch.title !== undefined) push('title', patch.title)
  if (patch.intro !== undefined) push('intro', patch.intro)
  if (patch.genre !== undefined) push('genre', patch.genre)
  if (patch.styleName !== undefined) push('style_name', patch.styleName)
  if (patch.styleSample !== undefined) push('style_sample', patch.styleSample)
  if (patch.styleNotes !== undefined) push('style_notes', patch.styleNotes)
  if (patch.styleSampleSource !== undefined) push('style_sample_source', patch.styleSampleSource)
  if (patch.sampleSources !== undefined) push('sample_sources', JSON.stringify(patch.sampleSources))
  if (patch.targetWords !== undefined) push('target_words', patch.targetWords)
  if (patch.redlines !== undefined) push('redlines', JSON.stringify(patch.redlines))
  if (patch.positiveWords !== undefined) push('positive_words', JSON.stringify(patch.positiveWords))
  if (patch.negativeWords !== undefined) push('negative_words', JSON.stringify(patch.negativeWords))
  if (patch.planMode !== undefined) push('plan_mode', patch.planMode ? 1 : 0)
  if (patch.archived !== undefined) push('archived', patch.archived ? 1 : 0)
  if (!set.length) return getBook(id)
  push('updated_at', Date.now())
  vals.push(id)
  getDb()
    .prepare(`UPDATE books SET ${set.join(', ')} WHERE id = ?`)
    .run(...vals)
  return getBook(id)
}

/** 删书（D4：真删除仅此与删线；删除前自动快照当日库） */
export function deleteBook(id: string): boolean {
  const book = getBook(id)
  if (!book) return false
  snapshotDb(`book-${id.slice(0, 8)}`)
  getDb().prepare('DELETE FROM books WHERE id = ?').run(id)
  return true
}

// ── lines（分叉树核心） ──────────────────────────────────────────────────────

export function listLines(bookId: string): StoryLine[] {
  return (
    getDb()
      .prepare('SELECT * FROM lines WHERE book_id = ? ORDER BY created_at')
      .all(bookId) as Record<string, unknown>[]
  ).map(rowToLine)
}

export function getLine(id: string): StoryLine | null {
  const r = getDb().prepare('SELECT * FROM lines WHERE id = ?').get(id)
  return r ? rowToLine(r) : null
}

export function activeLine(book: Book): StoryLine | null {
  return book.activeLineId ? getLine(book.activeLineId) : null
}

export function getLineThrow(lineId: string): StoryLine {
  const line = getLine(lineId)
  if (!line) throw new Error(`line ${lineId} 不存在`)
  return line
}

/**
 * 开新线（D1）：从 forkChapterId 之后分叉。
 * 深拷贝 cards/characters/foreshadows/memories 到新线——此后各线独立演化（真平行宇宙）。
 */
export function forkLine(
  bookId: string,
  forkChapterId: string,
  name: string,
  note = ''
): StoryLine | null {
  const db = getDb()
  const book = getBook(bookId)
  if (!book) return null
  const forkChapter = getChapter(forkChapterId)
  if (!forkChapter) return null
  const parentLine = getLineThrow(forkChapter.lineId)
  if (parentLine.bookId !== bookId) return null
  const now = Date.now()
  const lineId = randomUUID()

  // 深拷贝列白名单（与 db.ts 建表列对齐；列名来自本常量，无注入面）
  const COPY_COLUMNS = {
    cards: ['kind', 'title', 'reader_text', 'author_text', 'reveal_plan', 'data', 'pinned', 'tags'],
    characters: ['name', 'role', 'data', 'state', 'relations', 'pinned', 'tags'],
    foreshadows: [
      'title',
      'detail',
      'planted_chapter_id',
      'planned_chapter_id',
      'resolved_chapter_id',
      'status',
      'priority'
    ]
  } as const

  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO lines (id, book_id, parent_line_id, fork_chapter_id, fork_order, name, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(lineId, bookId, parentLine.id, forkChapterId, forkChapter.orderNo, name, note, now)

    // 设定深拷贝（新 id，挂新线；created_at 保留原值）
    for (const t of ['cards', 'characters', 'foreshadows'] as const) {
      const rows = db.prepare(`SELECT * FROM ${t} WHERE line_id = ?`).all(parentLine.id) as Record<
        string,
        SQLInputValue | undefined
      >[]
      const cols = COPY_COLUMNS[t]
      const ins = db.prepare(
        `INSERT INTO ${t} (id, book_id, line_id, ${cols.join(', ')}, created_at, updated_at)
         VALUES (${['id', 'book_id', 'line_id', ...cols].map(() => '?').join(', ')}, ?, ?)`
      )
      for (const r of rows) {
        ins.run(
          randomUUID(),
          bookId,
          lineId,
          ...cols.map((c) => r[c] ?? ''),
          r.created_at ?? now,
          now
        )
      }
    }

    // 旧的逐章压缩块：只带 fork 点之前的块（部分覆盖的块整块带过——压缩摘要多带无害）
    const memRows = db
      .prepare("SELECT * FROM memories WHERE line_id = ? AND kind = 'legacy' AND to_order <= ?")
      .all(parentLine.id, forkChapter.orderNo) as Record<string, SQLInputValue | undefined>[]
    const memIns = db.prepare(
      `INSERT INTO memories (id, line_id, from_order, to_order, content, created_at, kind, last_chapter_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const r of memRows) {
      memIns.run(
        randomUUID(),
        lineId,
        r.from_order ?? 0,
        r.to_order ?? 0,
        r.content ?? '',
        r.created_at ?? now,
        'legacy',
        ''
      )
    }

    // 前情梗概：覆盖范围没越过分叉点的整行带过去，此后各线独立演化；
    // 越过了（含分叉点之后的剧情）不带，留给后台按本线的有效章重建。位置按新线的有效章序列算
    const running = getRunningMemory(parentLine.id)
    if (running) {
      const list = effectiveChapters(lineId)
      const anchorAt = list.findIndex((c) => c.id === running.lastChapterId)
      const forkAt = list.findIndex((c) => c.id === forkChapterId)
      if (anchorAt >= 0 && anchorAt <= forkAt) {
        memIns.run(
          randomUUID(),
          lineId,
          1,
          anchorAt + 1,
          running.content,
          running.createdAt,
          'running',
          running.lastChapterId
        )
      }
    }

    db.prepare('UPDATE books SET active_line_id = ?, updated_at = ? WHERE id = ?').run(
      lineId,
      now,
      bookId
    )
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return getLine(lineId)
}

/** 切换激活线（写作永远在激活线尾） */
export function activateLine(bookId: string, lineId: string): boolean {
  const db = getDb()
  const line = getLine(lineId)
  if (!line || line.bookId !== bookId) return false
  db.prepare('UPDATE books SET active_line_id = ?, updated_at = ? WHERE id = ?').run(
    lineId,
    Date.now(),
    bookId
  )
  return true
}

/** 删线（D4）：级联删子树（所有 fork 自它的线），主线不可删；删前快照 */
export function deleteLine(lineId: string): boolean {
  const db = getDb()
  const line = getLine(lineId)
  if (!line) return false
  if (!line.parentLineId) throw new Error('主线不可删除')
  snapshotDb(`line-${lineId.slice(0, 8)}`)
  const collect = (id: string, acc: string[] = []): string[] => {
    acc.push(id)
    const children = (
      db.prepare('SELECT id FROM lines WHERE parent_line_id = ?').all(id) as Record<
        string,
        unknown
      >[]
    ).map((r) => r.id as string)
    for (const c of children) collect(c, acc)
    return acc
  }
  const all = collect(lineId)
  const _tx = db
  db.exec('BEGIN')
  try {
    for (const id of all) db.prepare('DELETE FROM lines WHERE id = ?').run(id)
    // 激活线被删则回退主线
    const book = getBook(line.bookId)
    if (book && all.includes(book.activeLineId)) {
      const main = db
        .prepare(`SELECT id FROM lines WHERE book_id = ? AND parent_line_id = ''`)
        .get(line.bookId) as { id: string } | undefined
      if (main)
        db.prepare('UPDATE books SET active_line_id = ? WHERE id = ?').run(main.id, line.bookId)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return true
}

// ── chapters ─────────────────────────────────────────────────────────────────

export function listChapters(lineId: string): Chapter[] {
  return (
    getDb()
      .prepare('SELECT * FROM chapters WHERE line_id = ? ORDER BY order_no')
      .all(lineId) as Record<string, unknown>[]
  ).map(rowToChapter)
}

export function getChapter(id: string): Chapter | null {
  const r = getDb().prepare('SELECT * FROM chapters WHERE id = ?').get(id)
  return r ? rowToChapter(r) : null
}

/**
 * 线的有效章列表（分叉树核心读操作）：
 * 祖先线中 fork 点之前（含）的章 + 本线全部章，按序拼接。
 * 目录/阅读/写作上下文/记忆组装都以此为准。
 */
export function effectiveChapters(lineId: string): Chapter[] {
  const line = getLineThrow(lineId)
  const own = listChapters(lineId)
  if (!line.parentLineId) return own
  // 分叉点章还在：以它为准；已被删（历史遗留）：按建线时记下的序号切，
  // 保住更早的祖先章，而不是把整条祖先线丢掉
  const fork = getChapter(line.forkChapterId)
  const cut = fork ? fork.orderNo : line.forkOrder
  if (!fork && cut < 0) return own
  const parentPart = effectiveChapters(fork ? fork.lineId : line.parentLineId).filter(
    (c) => c.orderNo <= cut
  )
  return [...parentPart, ...own]
}

/** 上一章（写作接缝用）：有效章列表尾章 */
export function previousChapter(lineId: string): Chapter | null {
  const list = effectiveChapters(lineId)
  return list.length ? (list[list.length - 1] as Chapter) : null
}

/** 入书（W4）：finalize 步落库 */
export function insertChapter(input: {
  lineId: string
  parentChapterId: string
  title: string
  content: string
  summary: string
  meta: ChapterMeta
}): Chapter {
  const db = getDb()
  const now = Date.now()
  const id = randomUUID()
  const max = db
    .prepare('SELECT MAX(order_no) AS m FROM chapters WHERE line_id = ?')
    .get(input.lineId) as { m: number | null }
  const orderNo = (max.m ?? 0) + 1
  db.prepare(
    `INSERT INTO chapters (id, line_id, parent_chapter_id, order_no, title, content, word_count, summary, meta, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.lineId,
    input.parentChapterId,
    orderNo,
    input.title,
    input.content,
    countWords(input.content),
    input.summary,
    JSON.stringify(input.meta),
    now,
    now
  )
  return getChapter(id) as Chapter
}

/** 改章：直接替换（用户决策：不留旧版，改了就是改了） */
export function replaceChapterContent(chapterId: string, content: string): Chapter | null {
  const db = getDb()
  const ch = getChapter(chapterId)
  if (!ch) return null
  db.prepare('UPDATE chapters SET content = ?, word_count = ?, updated_at = ? WHERE id = ?').run(
    content,
    countWords(content),
    Date.now(),
    chapterId
  )
  return getChapter(chapterId)
}

/** 纪要摘要写回（入书时由 commit_chapter 写入；改稿后后台按新正文重写） */
export function updateChapterSummary(chapterId: string, summary: string): void {
  getDb()
    .prepare('UPDATE chapters SET summary = ?, updated_at = ? WHERE id = ?')
    .run(summary, Date.now(), chapterId)
}

/** 以该章为起点、仍然存在的分叉线（删章前的保护检查） */
export function forkPointOf(chapterId: string): { id: string; name: string } | null {
  const r = getDb()
    .prepare('SELECT id, name FROM lines WHERE fork_chapter_id = ?')
    .get(chapterId) as { id: string; name: string } | undefined
  return r ? { id: r.id, name: r.name || '未命名线' } : null
}

/**
 * 删章（agent 写作回退用）：只允许删本线最后一章，保持 order_no 稠密。
 */
export function deleteLastChapter(lineId: string): Chapter | null {
  const db = getDb()
  const chapters = listChapters(lineId)
  const last = chapters[chapters.length - 1]
  if (!last) return null
  const fork = forkPointOf(last.id)
  if (fork) {
    throw new Error(`《${last.title}》是分叉线「${fork.name}」的起点，不能删；要删请先删那条分叉线`)
  }
  db.prepare('DELETE FROM chapter_versions WHERE chapter_id = ?').run(last.id)
  db.prepare('DELETE FROM chapters WHERE id = ?').run(last.id)
  // 前情梗概盖到了被删的章：不做「反合并」，直接删掉，之后由后台按现有章节重建
  const running = getRunningMemory(lineId)
  if (running && !effectiveChapters(lineId).some((c) => c.id === running.lastChapterId))
    deleteRunningMemory(lineId)
  return last
}

// ── cards / characters / foreshadows（挂 line，各线独立） ─────────────────────

export function listCards(lineId: string, opts?: { kind?: string; q?: string }): Card[] {
  const db = getDb()
  let sql = 'SELECT * FROM cards WHERE line_id = ?'
  const vals: SQLInputValue[] = [lineId]
  if (opts?.kind) {
    sql += ' AND kind = ?'
    vals.push(opts.kind)
  }
  if (opts?.q) {
    sql += ' AND (title LIKE ? OR reader_text LIKE ? OR author_text LIKE ?)'
    const like = `%${opts.q}%`
    vals.push(like, like, like)
  }
  sql += ' ORDER BY pinned DESC, updated_at DESC'
  return (db.prepare(sql).all(...vals) as Record<string, unknown>[]).map(rowToCard)
}

export function getCard(id: string): Card | null {
  const r = getDb().prepare('SELECT * FROM cards WHERE id = ?').get(id)
  return r ? rowToCard(r) : null
}

/** 类别清单（含各类卡数）——类别由卡派生，无卡的类别不出现 */
export function listCardKinds(lineId: string): Array<{ kind: string; count: number }> {
  const rows = getDb()
    .prepare(
      'SELECT kind, COUNT(*) AS n FROM cards WHERE line_id = ? GROUP BY kind ORDER BY n DESC'
    )
    .all(lineId) as Array<Record<string, unknown>>
  return rows.map((r) => ({ kind: (r.kind as string) ?? 'custom', count: Number(r.n) }))
}

/** 整类重命名：该类别全部卡迁移到新类别（不动内容不刷 updated_at），返回迁移卡数 */
export function renameCardKind(lineId: string, oldKind: string, newKind: string): number {
  const r = getDb()
    .prepare('UPDATE cards SET kind = ? WHERE line_id = ? AND kind = ?')
    .run(newKind, lineId, oldKind)
  return Number(r.changes)
}

export interface CardInput {
  lineId: string
  kind?: string
  /** 改卡可不传（保留原名）；新建缺省「未命名」 */
  title?: string
  readerText?: string
  authorText?: string
  revealPlan?: string
  /** 结构化数据：对象数组渲染成表格（AI 表格化 CRUD） */
  data?: Record<string, unknown>
  pinned?: boolean
  tags?: string[]
}

export function saveCard(input: CardInput & { id?: string }): Card | null {
  const db = getDb()
  const now = Date.now()
  const line = getLineThrow(input.lineId)
  if (input.id) {
    const old = getCard(input.id)
    if (!old) return null
    db.prepare(
      `UPDATE cards SET kind = ?, title = ?, reader_text = ?, author_text = ?, reveal_plan = ?, data = ?, pinned = ?, tags = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.kind ?? old.kind,
      input.title ?? old.title,
      input.readerText ?? old.readerText,
      input.authorText ?? old.authorText,
      input.revealPlan ?? old.revealPlan,
      JSON.stringify(input.data ?? old.data),
      (input.pinned ?? old.pinned) ? 1 : 0,
      JSON.stringify(input.tags ?? old.tags),
      now,
      input.id
    )
    return getCard(input.id)
  }
  const id = randomUUID()
  db.prepare(
    `INSERT INTO cards (id, book_id, line_id, kind, title, reader_text, author_text, reveal_plan, data, pinned, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    line.bookId,
    input.lineId,
    input.kind ?? 'custom',
    input.title ?? '未命名',
    input.readerText ?? '',
    input.authorText ?? '',
    input.revealPlan ?? '',
    JSON.stringify(input.data ?? {}),
    input.pinned ? 1 : 0,
    JSON.stringify(input.tags ?? []),
    now,
    now
  )
  return getCard(id)
}

export function deleteCard(id: string): boolean {
  const r = getDb().prepare('DELETE FROM cards WHERE id = ?').run(id)
  return Number(r.changes) > 0
}

export function listCharacters(lineId: string, opts?: { q?: string }): Character[] {
  const db = getDb()
  let sql = 'SELECT * FROM characters WHERE line_id = ?'
  const vals: SQLInputValue[] = [lineId]
  if (opts?.q) {
    sql += ' AND (name LIKE ? OR role LIKE ? OR data LIKE ?)'
    const like = `%${opts.q}%`
    vals.push(like, like, like)
  }
  sql += ' ORDER BY pinned DESC, updated_at DESC'
  return (db.prepare(sql).all(...vals) as Record<string, unknown>[]).map(rowToCharacter)
}

export function getCharacter(id: string): Character | null {
  const r = getDb().prepare('SELECT * FROM characters WHERE id = ?').get(id)
  return r ? rowToCharacter(r) : null
}

export interface CharacterInput {
  lineId: string
  /** 改人物可不传（保留原名）；新建缺省「未命名」 */
  name?: string
  role?: string
  data?: Record<string, unknown>
  state?: CharacterState
  relations?: Character['relations']
  pinned?: boolean
  tags?: string[]
}

export function saveCharacter(input: CharacterInput & { id?: string }): Character | null {
  const db = getDb()
  const now = Date.now()
  const line = getLineThrow(input.lineId)
  if (input.id) {
    const old = getCharacter(input.id)
    if (!old) return null
    db.prepare(
      `UPDATE characters SET name = ?, role = ?, data = ?, state = ?, relations = ?, pinned = ?, tags = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.name ?? old.name,
      input.role ?? old.role,
      JSON.stringify(input.data ?? old.data),
      JSON.stringify(input.state ?? old.state),
      JSON.stringify(input.relations ?? old.relations),
      (input.pinned ?? old.pinned) ? 1 : 0,
      JSON.stringify(input.tags ?? old.tags),
      now,
      input.id
    )
    return getCharacter(input.id)
  }
  const id = randomUUID()
  db.prepare(
    `INSERT INTO characters (id, book_id, line_id, name, role, data, state, relations, pinned, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    line.bookId,
    input.lineId,
    input.name ?? '未命名',
    input.role ?? '',
    JSON.stringify(input.data ?? {}),
    JSON.stringify(input.state ?? {}),
    JSON.stringify(input.relations ?? []),
    input.pinned ? 1 : 0,
    JSON.stringify(input.tags ?? []),
    now,
    now
  )
  return getCharacter(id)
}

/** 人设 tags 增量更新（add/delete 去重保序） */
export function updateCharacterTags(
  id: string,
  opts: { add?: string[]; delete?: string[] }
): Character | null {
  const old = getCharacter(id)
  if (!old) return null
  const del = new Set(opts.delete ?? [])
  const next: string[] = []
  for (const t of [...old.tags, ...(opts.add ?? [])]) {
    if (!del.has(t) && !next.includes(t)) next.push(t)
  }
  getDb()
    .prepare('UPDATE characters SET tags = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(next), Date.now(), id)
  return getCharacter(id)
}

/** 人设 data 浅合并（只改传入的顶层键，未传键保留原值） */
export function updateCharacterData(id: string, merge: Record<string, unknown>): Character | null {
  const old = getCharacter(id)
  if (!old) return null
  const next = { ...old.data, ...merge }
  getDb()
    .prepare('UPDATE characters SET data = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(next), Date.now(), id)
  return getCharacter(id)
}

/** agent 收尾批量更新活状态（B8）；人不可见的内部接口 */
export function patchCharacterStates(patches: Array<{ id: string; patch: CharacterState }>): void {
  const db = getDb()
  const now = Date.now()
  const upd = db.prepare('UPDATE characters SET state = ?, updated_at = ? WHERE id = ?')
  for (const p of patches) {
    const old = getCharacter(p.id)
    if (!old) continue
    upd.run(JSON.stringify({ ...old.state, ...p.patch }), now, p.id)
  }
}

export function deleteCharacter(id: string): boolean {
  const r = getDb().prepare('DELETE FROM characters WHERE id = ?').run(id)
  return Number(r.changes) > 0
}

export function listForeshadows(lineId: string, status?: ForeshadowStatus): Foreshadow[] {
  const db = getDb()
  let sql = 'SELECT * FROM foreshadows WHERE line_id = ?'
  const vals: SQLInputValue[] = [lineId]
  if (status) {
    sql += ' AND status = ?'
    vals.push(status)
  }
  sql += ' ORDER BY priority DESC, updated_at DESC'
  return (db.prepare(sql).all(...vals) as Record<string, unknown>[]).map(rowToForeshadow)
}

export function getForeshadow(id: string): Foreshadow | null {
  const r = getDb().prepare('SELECT * FROM foreshadows WHERE id = ?').get(id)
  return r ? rowToForeshadow(r) : null
}

export interface ForeshadowInput {
  lineId: string
  /** 改伏笔可不传（保留原名）；新建缺省「未命名伏笔」 */
  title?: string
  detail?: string
  plantedChapterId?: string
  plannedChapterId?: string
  resolvedChapterId?: string
  status?: ForeshadowStatus
  priority?: number
}

export function saveForeshadow(input: ForeshadowInput & { id?: string }): Foreshadow | null {
  const db = getDb()
  const now = Date.now()
  const line = getLineThrow(input.lineId)
  if (input.id) {
    const old = getForeshadow(input.id)
    if (!old) return null
    db.prepare(
      `UPDATE foreshadows SET title = ?, detail = ?, planted_chapter_id = ?, planned_chapter_id = ?, resolved_chapter_id = ?, status = ?, priority = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.title ?? old.title,
      input.detail ?? old.detail,
      input.plantedChapterId ?? old.plantedChapterId,
      input.plannedChapterId ?? old.plannedChapterId,
      input.resolvedChapterId ?? old.resolvedChapterId,
      input.status ?? old.status,
      input.priority ?? old.priority,
      now,
      input.id
    )
    return getForeshadow(input.id)
  }
  const id = randomUUID()
  db.prepare(
    `INSERT INTO foreshadows (id, book_id, line_id, title, detail, planted_chapter_id, planned_chapter_id, resolved_chapter_id, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    line.bookId,
    input.lineId,
    input.title ?? '未命名伏笔',
    input.detail ?? '',
    input.plantedChapterId ?? '',
    input.plannedChapterId ?? '',
    input.resolvedChapterId ?? '',
    input.status ?? 'open',
    input.priority ?? 1,
    now,
    now
  )
  return getForeshadow(id)
}

export function deleteForeshadow(id: string): boolean {
  const r = getDb().prepare('DELETE FROM foreshadows WHERE id = ?').run(id)
  return r.changes > 0
}

// ── memories（前情梗概 running + 旧的逐章压缩块 legacy） ─────────────────────

export function listMemories(lineId: string, kind?: MemoryKind): MemoryBlock[] {
  const db = getDb()
  const rows = kind
    ? (db
        .prepare('SELECT * FROM memories WHERE line_id = ? AND kind = ? ORDER BY from_order')
        .all(lineId, kind) as Record<string, unknown>[])
    : (db
        .prepare('SELECT * FROM memories WHERE line_id = ? ORDER BY from_order')
        .all(lineId) as Record<string, unknown>[])
  return rows.map(rowToMemory)
}

/** 本线的前情梗概（每线至多一行 running；没有返回 null，调用方回退到旧的压缩块） */
export function getRunningMemory(lineId: string): MemoryBlock | null {
  const r = getDb()
    .prepare("SELECT * FROM memories WHERE line_id = ? AND kind = 'running'")
    .get(lineId) as Record<string, unknown> | undefined
  return r ? rowToMemory(r) : null
}

/** 写入或原地更新本线的前情梗概（同一条线复用同一行，不追加） */
export function upsertRunningMemory(input: {
  lineId: string
  content: string
  toOrder: number
  lastChapterId: string
}): void {
  const db = getDb()
  const updated = db
    .prepare(
      "UPDATE memories SET content = ?, to_order = ?, last_chapter_id = ? WHERE line_id = ? AND kind = 'running'"
    )
    .run(input.content, input.toOrder, input.lastChapterId, input.lineId)
  if (Number(updated.changes) > 0) return
  db.prepare(
    `INSERT INTO memories (id, line_id, from_order, to_order, content, created_at, kind, last_chapter_id)
     VALUES (?, ?, 1, ?, ?, ?, 'running', ?)`
  ).run(randomUUID(), input.lineId, input.toOrder, input.content, Date.now(), input.lastChapterId)
}

export function deleteRunningMemory(lineId: string): void {
  getDb().prepare("DELETE FROM memories WHERE line_id = ? AND kind = 'running'").run(lineId)
}

// ── messages（对话历史，M5 按章回看） ─────────────────────────────────────────

/** 消息时间戳单调递增兜底：同一毫秒内连续落库（思考/工具卡交错）时排序仍稳定 */
let lastMsgTs = 0

export function appendMessage(input: {
  bookId: string
  chapterId?: string
  role: 'user' | 'assistant'
  content: string
  meta?: Record<string, unknown>
}): ChatMessageRow {
  const db = getDb()
  const id = randomUUID()
  const now = Math.max(Date.now(), lastMsgTs + 1)
  lastMsgTs = now
  // 用户第一次发言 = 书真正立起来（草稿转正，用户决策：没产生对话的书不算书）
  if (input.role === 'user') {
    db.prepare('UPDATE books SET draft = 0 WHERE id = ? AND draft = 1').run(input.bookId)
  }
  db.prepare(
    `INSERT INTO messages (id, book_id, chapter_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.bookId,
    input.chapterId ?? '',
    input.role,
    input.content,
    JSON.stringify(input.meta ?? {}),
    now
  )
  return rowToMessage(
    db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown>
  )
}

export function listMessages(
  bookId: string,
  opts?: { chapterId?: string; limit?: number }
): ChatMessageRow[] {
  const db = getDb()
  let sql = 'SELECT * FROM messages WHERE book_id = ?'
  const vals: SQLInputValue[] = [bookId]
  if (opts?.chapterId) {
    sql += ' AND chapter_id = ?'
    vals.push(opts.chapterId)
  }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  vals.push(opts?.limit ?? 200)
  return (db.prepare(sql).all(...vals) as Record<string, unknown>[]).map(rowToMessage).reverse()
}

// ── jobs（任务流水线 W12；执行编排在 jobs.ts） ───────────────────────────────

export function insertJob(input: {
  bookId: string
  lineId: string
  kind: JobKind
  payload?: Partial<JobPayload>
}): Job {
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO jobs (id, book_id, line_id, kind, state, payload, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`
  ).run(id, input.bookId, input.lineId, input.kind, JSON.stringify(input.payload ?? {}), now, now)
  return getJob(id) as Job
}

export function getJob(id: string): Job | null {
  const r = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id)
  return r ? rowToJob(r) : null
}

export function listJobs(bookId?: string, limit = 20): Job[] {
  const db = getDb()
  const sql = bookId
    ? 'SELECT * FROM jobs WHERE book_id = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?'
  const vals = bookId ? [bookId, limit] : [limit]
  return (db.prepare(sql).all(...vals) as Record<string, unknown>[]).map(rowToJob)
}

export type JobPatch = {
  state?: JobState
  step?: JobStep | ''
  payload?: Partial<JobPayload>
  error?: string
  chapterId?: string
  watchdogAt?: number
}

export function updateJob(id: string, patch: JobPatch): Job | null {
  const db = getDb()
  const job = getJob(id)
  if (!job) return null
  const payload =
    patch.payload !== undefined
      ? JSON.stringify({ ...job.payload, ...patch.payload })
      : JSON.stringify(job.payload)
  db.prepare(
    `UPDATE jobs SET state = ?, step = ?, payload = ?, error = ?, chapter_id = ?, watchdog_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    patch.state ?? job.state,
    patch.step ?? job.step,
    payload,
    patch.error ?? job.error,
    patch.chapterId ?? job.chapterId,
    patch.watchdogAt ?? job.watchdogAt,
    Date.now(),
    id
  )
  return getJob(id)
}

/**
 * 任务收尾（条件写入）：仍是 running 才落，已被取消/看门狗先定终态的不覆盖。
 * 返回任务当前实际状态——调用方据此判断自己是否「跑输了」（如已被取消）。
 */
export function finishJob(id: string, patch: JobPatch): Job | null {
  const db = getDb()
  const job = getJob(id)
  if (!job) return null
  const payload =
    patch.payload !== undefined
      ? JSON.stringify({ ...job.payload, ...patch.payload })
      : JSON.stringify(job.payload)
  db.prepare(
    `UPDATE jobs SET state = ?, step = ?, payload = ?, error = ?, chapter_id = ?, watchdog_at = ?, updated_at = ?
     WHERE id = ? AND state = 'running'`
  ).run(
    patch.state ?? job.state,
    patch.step ?? job.step,
    payload,
    patch.error ?? job.error,
    patch.chapterId ?? job.chapterId,
    patch.watchdogAt ?? job.watchdogAt,
    Date.now(),
    id
  )
  return getJob(id)
}

/** 队列按先来后到取下一个（同毫秒入库的按落库顺序） */
export function nextQueuedJob(): Job | null {
  const r = getDb()
    .prepare(`SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1`)
    .get()
  return r ? rowToJob(r) : null
}

function markJobsFailed(ids: string[], reason: string): void {
  if (!ids.length) return
  const db = getDb()
  const stmt = db.prepare(
    `UPDATE jobs SET state = 'failed', error = ?, updated_at = ? WHERE id = ? AND state = 'running'`
  )
  for (const id of ids) stmt.run(reason, Date.now(), id)
}

/** 看门狗（W12）：running 且超时无进展的任务标 failed，返回被终止的任务 id */
export function failStuckJobs(timeoutMs = 10 * 60 * 1000): string[] {
  const ids = (
    getDb()
      .prepare(
        `SELECT id FROM jobs WHERE state = 'running' AND watchdog_at > 0 AND watchdog_at < ?`
      )
      .all(Date.now() - timeoutMs) as { id: string }[]
  ).map((r) => r.id)
  markJobsFailed(ids, `超过 ${Math.max(1, Math.round(timeoutMs / 60000))} 分钟没有新进展，已终止`)
  return ids
}

/** 服务重启后的恢复：上个进程遗留的 running 任务不可能再完成 */
export function failInterruptedJobs(): string[] {
  const ids = (
    getDb().prepare(`SELECT id FROM jobs WHERE state = 'running'`).all() as { id: string }[]
  ).map((r) => r.id)
  markJobsFailed(ids, '电脑端服务重启，任务被打断')
  return ids
}

// ── 范文（完整书入库，agent 节选翻阅） ───────────────────────────────────────

/** 列表/摘要只取前 120 字预览，不把范文全文读进内存 */
const SAMPLE_BRIEF_SQL =
  'SELECT id, name, chars, created_at, substr(content, 1, 120) AS preview FROM samples'

function rowToSample(r: Record<string, unknown>): SampleInfo {
  return {
    id: r.id as string,
    name: r.name as string,
    chars: (r.chars as number) ?? 0,
    preview: (r.preview as string) ?? '',
    createdAt: r.created_at as number
  }
}

/**
 * 导入范文：只增不改——同名已存在也不覆盖（用户硬约束：已导入的范文必须保留），
 * 书名撞了就另存为「名（2）」「名（3）」。导入即结构化切节（章+资料段）。
 * 返回值里的 name 是最终入库的书名，调用方据此提示作者是否另存。
 */
export function saveSample(name: string, content: string): SampleInfo {
  const db = getDb()
  const clean = content.replace(/\r\n/g, '\n')
  const chars = clean.length
  const id = randomUUID()
  db.prepare(
    'INSERT INTO samples (id, name, chars, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, uniqueSampleName(db, name), chars, clean, Date.now())
  const chapterCount = writeSampleSections(id, clean)
  const r = db.prepare(`${SAMPLE_BRIEF_SQL} WHERE id = ?`).get(id) as Record<string, unknown>
  return { ...rowToSample(r), chapterCount }
}

/** 撞名时顺延成「名（2）」「名（3）」…（范文总量小，读一遍全部书名足够） */
function uniqueSampleName(db: DatabaseSync, base: string): string {
  const rows = db.prepare('SELECT name FROM samples').all() as { name: string }[]
  const taken = new Set(rows.map((r) => r.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}（${n}）`
    if (!taken.has(candidate)) return candidate
  }
}

/** 结构化切节入库（章+资料大段），供 read_sample 直达检索；返回切出的章数 */
function writeSampleSections(sampleId: string, content: string): number {
  const sections = parseSampleSections(sampleId, content)
  const db = getDb()
  const ins = db.prepare(
    'INSERT INTO sample_sections (id, sample_id, kind, label, start, end, chars) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  db.exec('BEGIN')
  try {
    for (const s of sections) ins.run(s.id, s.sampleId, s.kind, s.label, s.start, s.end, s.chars)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return sections.filter((s) => s.kind === 'chapter').length
}

/** 幂等懒解析：老库范文首次访问时补切节 */
export function ensureSampleParsed(sampleId: string): void {
  const db = getDb()
  const has = db
    .prepare('SELECT COUNT(*) n FROM sample_sections WHERE sample_id = ?')
    .get(sampleId) as { n: number }
  if ((has?.n ?? 0) > 0) return
  const r = db.prepare('SELECT content FROM samples WHERE id = ?').get(sampleId) as
    | { content: string }
    | undefined
  if (!r?.content) return
  writeSampleSections(sampleId, r.content)
}

export interface SampleSectionRow {
  kind: 'chapter' | 'section'
  label: string
  start: number
  end: number
  chars: number
}

/** 某范文的全部节（先保证已解析） */
export function listSampleSections(sampleId: string): SampleSectionRow[] {
  ensureSampleParsed(sampleId)
  return getDb()
    .prepare(
      'SELECT kind, label, start, end, chars FROM sample_sections WHERE sample_id = ? ORDER BY start'
    )
    .all(sampleId) as unknown as SampleSectionRow[]
}

/** 关键词搜节：label 命中优先；否则全文定位含关键词的最近节 */
export function searchSampleSections(
  sampleId: string,
  content: string,
  q: string
): { section: SampleSectionRow | null; offset: number; snippet: string } {
  const sections = listSampleSections(sampleId)
  const byLabel = sections.find((s) => s.label.includes(q))
  if (byLabel) return { section: byLabel, offset: byLabel.start, snippet: '' }
  const idx = content.indexOf(q)
  if (idx >= 0) {
    const sec = [...sections].reverse().find((s) => s.start <= idx && idx < s.end) ?? null
    const snippet = content.slice(Math.max(0, idx - 60), idx + q.length + 120)
    return { section: sec, offset: sec ? sec.start : Math.max(0, idx - 200), snippet }
  }
  return { section: null, offset: -1, snippet: '' }
}

export function listSamples(): SampleInfo[] {
  const db = getDb()
  const rows = db.prepare(`${SAMPLE_BRIEF_SQL} ORDER BY created_at DESC`).all() as Record<
    string,
    unknown
  >[]
  // 老库范文首次访问时补切节（幂等）
  for (const r of rows) ensureSampleParsed(r.id as string)
  const counts = db
    .prepare(
      "SELECT sample_id, COUNT(*) n FROM sample_sections WHERE kind = 'chapter' GROUP BY sample_id"
    )
    .all() as { sample_id: string; n: number }[]
  const byId = new Map(counts.map((c) => [c.sample_id, c.n]))
  return rows.map((r) => ({
    ...rowToSample(r),
    chapterCount: byId.get(r.id as string) ?? 0
  }))
}

/** 只查存在性，不读全文（绑定校验等轻量场景用） */
export function sampleExists(id: string): boolean {
  return Boolean(getDb().prepare('SELECT 1 FROM samples WHERE id = ?').get(id))
}

export function getSample(
  id: string
): { id: string; name: string; chars: number; content: string } | null {
  const r = getDb().prepare('SELECT * FROM samples WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  return {
    id: r.id as string,
    name: r.name as string,
    chars: (r.chars as number) ?? 0,
    content: (r.content as string) ?? ''
  }
}

export function deleteSample(id: string): boolean {
  const db = getDb()
  // 从各书的绑定数组中移除（书量小，读改写简单可靠）
  const books = db
    .prepare("SELECT id, sample_sources FROM books WHERE sample_sources LIKE '%' || ? || '%'")
    .all(id) as { id: string; sample_sources: string }[]
  const upd = db.prepare('UPDATE books SET sample_sources = ? WHERE id = ?')
  for (const b of books) {
    try {
      const arr = JSON.parse(b.sample_sources || '[]') as string[]
      const next = arr.filter((x) => x !== id)
      if (next.length !== arr.length) upd.run(JSON.stringify(next), b.id)
    } catch {
      upd.run('[]', b.id)
    }
  }
  db.prepare("UPDATE books SET style_sample_source = '' WHERE style_sample_source = ?").run(id)
  db.prepare('DELETE FROM sample_sections WHERE sample_id = ?').run(id)
  return db.prepare('DELETE FROM samples WHERE id = ?').run(id).changes > 0
}

/** 导出类型给 handlers/director 使用 */
export type { DatabaseSync }
