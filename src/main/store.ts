import { randomUUID } from 'node:crypto'
import { splitTags } from '../shared/tags'
import type {
  Chapter,
  ChapterBrief,
  ChapterSummary,
  Character,
  CharacterInput,
  Foreshadow,
  ForeshadowInput,
  OutlineInput,
  OutlineItem,
  OutlineStatus,
  Project,
  ProjectInput,
  VolumeSummary,
  WorldbuildEntry,
  WorldbuildInput
} from '../shared/types'
import { getDb } from './db'

type Row = Record<string, unknown>

function now(): number {
  return Date.now()
}

function mapProject(r: Row): Project {
  return {
    id: r.id as string,
    title: r.title as string,
    genre: (r.genre as string) ?? '',
    styleGuide: (r.style_guide as string) ?? '',
    targetWords: (r.target_words as number) ?? 0,
    status: (r.status as string) ?? 'active',
    wizardPlan: (r.wizard_plan as string) ?? '',
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

function mapCharacter(r: Row): Character {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    role: (r.role as string) ?? '',
    tags: (r.tags as string) ?? '',
    card: (r.card as string) ?? '',
    state: (r.state as string) ?? '',
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

function mapWorldbuild(r: Row): WorldbuildEntry {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    category: (r.category as string) ?? '其他',
    title: r.title as string,
    tags: (r.tags as string) ?? '',
    keys: (r.keys as string) ?? '',
    content: (r.content as string) ?? '',
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

function mapOutline(r: Row): OutlineItem {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    volume: r.volume as number,
    chapterNo: r.chapter_no as number,
    title: (r.title as string) ?? '',
    synopsis: (r.synopsis as string) ?? '',
    role: (r.role as string) ?? '',
    suspense: (r.suspense as string) ?? '',
    twist: (r.twist as number) ?? 0,
    hook: (r.hook as string) ?? '',
    foreshadowOps: (r.foreshadow_ops as string) ?? '',
    status: ((r.status as string) ?? 'draft') as OutlineStatus,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

export function listProjects(): Project[] {
  return getDb()
    .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
    .all()
    .map((r) => mapProject(r as Row))
}

export function createProject(input: ProjectInput): Project {
  const id = randomUUID()
  const ts = now()
  getDb()
    .prepare(
      'INSERT INTO projects (id, title, genre, style_guide, target_words, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, input.title, input.genre ?? '', input.styleGuide ?? '', input.targetWords ?? 0, ts, ts)
  return mapProject(getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row)
}

export function updateProject(id: string, input: Partial<ProjectInput>): void {
  const db = getDb()
  const cur = mapProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row)
  db.prepare(
    'UPDATE projects SET title = ?, genre = ?, style_guide = ?, target_words = ?, wizard_plan = ?, updated_at = ? WHERE id = ?'
  ).run(
    input.title ?? cur.title,
    input.genre ?? cur.genre,
    input.styleGuide ?? cur.styleGuide,
    input.targetWords ?? cur.targetWords,
    input.wizardPlan ?? cur.wizardPlan,
    now(),
    id
  )
}

export function deleteProject(id: string): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
}

export function listCharacters(projectId: string): Character[] {
  return getDb()
    .prepare('SELECT * FROM characters WHERE project_id = ? ORDER BY created_at')
    .all(projectId)
    .map((r) => mapCharacter(r as Row))
}

export function saveCharacter(input: CharacterInput & { id?: string }): Character {
  const db = getDb()
  const ts = now()
  if (input.id) {
    const cur = mapCharacter(
      db.prepare('SELECT * FROM characters WHERE id = ?').get(input.id) as Row
    )
    db.prepare(
      'UPDATE characters SET name = ?, role = ?, tags = ?, card = ?, state = ?, updated_at = ? WHERE id = ?'
    ).run(
      input.name,
      input.role ?? cur.role,
      input.tags ?? cur.tags,
      input.card ?? cur.card,
      input.state ?? cur.state,
      ts,
      input.id
    )
    return mapCharacter(db.prepare('SELECT * FROM characters WHERE id = ?').get(input.id) as Row)
  }
  const id = randomUUID()
  db.prepare(
    'INSERT INTO characters (id, project_id, name, role, tags, card, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    input.projectId,
    input.name,
    input.role ?? '',
    input.tags ?? '',
    input.card ?? '',
    input.state ?? '',
    ts,
    ts
  )
  return mapCharacter(db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as Row)
}

export function deleteCharacter(id: string): void {
  getDb().prepare('DELETE FROM characters WHERE id = ?').run(id)
}

export function listWorldbuild(projectId: string): WorldbuildEntry[] {
  return getDb()
    .prepare('SELECT * FROM worldbuild WHERE project_id = ? ORDER BY category, created_at')
    .all(projectId)
    .map((r) => mapWorldbuild(r as Row))
}

/** 标题改名后全局传播 [[旧标题]] -> [[新标题]]（覆盖世界观/人物卡/大纲/章节里的引用，含带 |关系 的写法） */
function propagateWikiRenames(
  db: ReturnType<typeof getDb>,
  projectId: string,
  oldTitle: string,
  newTitle: string
): number {
  const o = oldTitle.trim()
  const n = newTitle.trim()
  if (!o || !n || o === n) return 0
  const like = `%[[${o}]%`
  let changed = 0
  const pairs: Array<[string, string]> = [
    ['worldbuild', 'content'],
    ['characters', 'card'],
    ['outlines', 'synopsis'],
    ['chapters', 'content']
  ]
  for (const [table, col] of pairs) {
    const r = db
      .prepare(
        `UPDATE ${table} SET ${col} = REPLACE(REPLACE(${col}, '[[${o}|', '[[${n}|'), '[[${o}]]', '[[${n}]]') WHERE project_id = ? AND ${col} LIKE ?`
      )
      .run(projectId, like)
    changed += Number(r.changes)
  }
  return changed
}

export function saveWorldbuild(input: WorldbuildInput & { id?: string }): WorldbuildEntry {
  const db = getDb()
  const ts = now()
  if (input.id) {
    const cur = mapWorldbuild(
      db.prepare('SELECT * FROM worldbuild WHERE id = ?').get(input.id) as Row
    )
    if (input.title?.trim() && input.title.trim() !== cur.title.trim()) {
      propagateWikiRenames(db, input.projectId, cur.title, input.title)
    }
    db.prepare(
      'UPDATE worldbuild SET category = ?, title = ?, tags = ?, keys = ?, content = ?, updated_at = ? WHERE id = ?'
    ).run(
      input.category,
      input.title,
      input.tags ?? cur.tags,
      input.keys ?? cur.keys,
      input.content ?? cur.content,
      ts,
      input.id
    )
    return mapWorldbuild(db.prepare('SELECT * FROM worldbuild WHERE id = ?').get(input.id) as Row)
  }
  const id = randomUUID()
  db.prepare(
    'INSERT INTO worldbuild (id, project_id, category, title, tags, keys, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    input.projectId,
    input.category,
    input.title,
    input.tags ?? '',
    input.keys ?? '',
    input.content ?? '',
    ts,
    ts
  )
  return mapWorldbuild(db.prepare('SELECT * FROM worldbuild WHERE id = ?').get(id) as Row)
}

export function deleteWorldbuild(id: string): void {
  getDb().prepare('DELETE FROM worldbuild WHERE id = ?').run(id)
}

export function deleteWorldbuildBatch(projectId: string, ids: string[]): number {
  const db = getDb()
  const del = db.prepare('DELETE FROM worldbuild WHERE project_id = ? AND id = ?')
  db.exec('BEGIN')
  try {
    let n = 0
    for (const id of ids) n += Number(del.run(projectId, id).changes)
    db.exec('COMMIT')
    return n
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

const DEFAULT_WORLDBUILD_TYPES = ['力量体系', '地理', '势力', '历史', '物品', '其他']

const TYPE_PRIORITY_PRESET: Record<string, number> = {
  地理: 10,
  势力: 20,
  历史: 30,
  力量体系: 40,
  物品: 50,
  其他: 10000
}

const TYPE_DEFAULT_PRIORITY = 100
const TYPE_MAX_PRIORITY = 9990

function typePriority(name: string): number {
  return TYPE_PRIORITY_PRESET[name] ?? TYPE_DEFAULT_PRIORITY
}

interface TypeRow {
  name: string
  priority: number
}

function sortTypeRows(rows: TypeRow[]): TypeRow[] {
  return rows.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, 'zh'))
}

export function listWorldbuildTypes(projectId: string): string[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT name, priority FROM worldbuild_types WHERE project_id = ?')
    .all(projectId) as Array<{ name: string; priority: number }>
  if (rows.length > 0) {
    return sortTypeRows(rows.map((r) => ({ name: r.name, priority: Number(r.priority) }))).map(
      (r) => r.name
    )
  }
  const used = new Set(
    (
      db
        .prepare('SELECT DISTINCT category FROM worldbuild WHERE project_id = ?')
        .all(projectId) as Array<{ category: string | null }>
    )
      .map((r) => r.category ?? '')
      .filter(Boolean)
  )
  const names = [...DEFAULT_WORLDBUILD_TYPES, ...used].filter((n, i, arr) => arr.indexOf(n) === i)
  const insert = db.prepare(
    'INSERT INTO worldbuild_types (id, project_id, name, priority, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  const ts = now()
  for (const n of names) insert.run(randomUUID(), projectId, n, typePriority(n), ts)
  return sortTypeRows(names.map((name) => ({ name, priority: typePriority(name) }))).map(
    (r) => r.name
  )
}

export function createWorldbuildType(projectId: string, name: string): string {
  const n = name.trim()
  if (!n) throw new Error('类型名不能为空')
  const db = getDb()
  const dupType = db
    .prepare('SELECT 1 FROM worldbuild_types WHERE project_id = ? AND name = ?')
    .get(projectId, n)
  if (dupType) throw new Error(`类型「${n}」已存在`)
  const tagHit = listWorldbuild(projectId).find((e) => splitTags(e.tags).includes(n))
  if (tagHit) throw new Error(`「${n}」已被条目《${tagHit.title}》用作标签，类型与标签不能重名`)
  db.prepare(
    'INSERT INTO worldbuild_types (id, project_id, name, priority, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), projectId, n, typePriority(n), now())
  return n
}

export interface WorldbuildTypePos {
  before?: string
  after?: string
  first?: boolean
  last?: boolean
}

export function reorderWorldbuildType(
  projectId: string,
  name: string,
  pos: WorldbuildTypePos
): string[] {
  if (name === '其他') throw new Error('「其他」恒为最后，无需调整')
  const db = getDb()
  const rows = db
    .prepare('SELECT name, priority FROM worldbuild_types WHERE project_id = ?')
    .all(projectId) as Array<{ name: string; priority: number }>
  const list = sortTypeRows(rows.map((r) => ({ name: r.name, priority: Number(r.priority) })))
  if (!list.some((r) => r.name === name)) throw new Error(`类型「${name}」不存在`)
  const others = list.filter((r) => r.name !== name)
  if (others.length === 0) return list.map((r) => r.name)
  const ways = [pos.before, pos.after, pos.first, pos.last].filter(Boolean).length
  if (ways !== 1) throw new Error('before / after / first / last 必须恰好提供一个')
  let priority: number
  if (pos.first) {
    priority = others[0].priority - 10
  } else if (pos.last) {
    priority = Math.min(TYPE_MAX_PRIORITY, Math.max(...others.map((r) => r.priority)) + 10)
  } else if (pos.before) {
    const t = others.find((r) => r.name === pos.before)
    if (!t) throw new Error(`类型「${pos.before}」不存在`)
    const idx = others.indexOf(t)
    const prev = others[idx - 1]?.priority ?? t.priority - 20
    priority = (prev + t.priority) / 2
  } else {
    const t = others.find((r) => r.name === pos.after)
    if (!t) throw new Error(`类型「${pos.after}」不存在`)
    if (t.priority >= TYPE_MAX_PRIORITY) throw new Error('「其他」恒为最后，不能插到其后')
    const idx = others.indexOf(t)
    const next = others[idx + 1]?.priority ?? t.priority + 20
    priority = (t.priority + next) / 2
  }
  priority = Math.min(TYPE_MAX_PRIORITY, priority)
  db.prepare('UPDATE worldbuild_types SET priority = ? WHERE project_id = ? AND name = ?').run(
    priority,
    projectId,
    name
  )
  return listWorldbuildTypes(projectId)
}

export function deleteWorldbuildType(projectId: string, name: string): void {
  const db = getDb()
  const used = db
    .prepare('SELECT COUNT(*) AS c FROM worldbuild WHERE project_id = ? AND category = ?')
    .get(projectId, name) as { c: number }
  if (used.c > 0) throw new Error(`类型「${name}」下还有 ${used.c} 个条目，请先迁移它们`)
  db.prepare('DELETE FROM worldbuild_types WHERE project_id = ? AND name = ?').run(projectId, name)
}

export function listOutlines(projectId: string): OutlineItem[] {
  return getDb()
    .prepare('SELECT * FROM outlines WHERE project_id = ? ORDER BY volume, chapter_no')
    .all(projectId)
    .map((r) => mapOutline(r as Row))
}

export function getOutline(id: string): OutlineItem | null {
  const r = getDb().prepare('SELECT * FROM outlines WHERE id = ?').get(id) as Row | undefined
  return r ? mapOutline(r) : null
}

export function saveOutline(input: OutlineInput & { id?: string }): OutlineItem {
  const db = getDb()
  const ts = now()
  if (input.id) {
    const cur = mapOutline(db.prepare('SELECT * FROM outlines WHERE id = ?').get(input.id) as Row)
    db.prepare(
      'UPDATE outlines SET volume = ?, chapter_no = ?, title = ?, synopsis = ?, role = ?, suspense = ?, twist = ?, hook = ?, foreshadow_ops = ?, status = ?, updated_at = ? WHERE id = ?'
    ).run(
      input.volume,
      input.chapterNo,
      input.title ?? cur.title,
      input.synopsis ?? cur.synopsis,
      input.role ?? cur.role,
      input.suspense ?? cur.suspense,
      input.twist ?? cur.twist,
      input.hook ?? cur.hook,
      input.foreshadowOps ?? cur.foreshadowOps,
      input.status ?? cur.status,
      ts,
      input.id
    )
    return mapOutline(db.prepare('SELECT * FROM outlines WHERE id = ?').get(input.id) as Row)
  }
  const id = randomUUID()
  db.prepare(
    'INSERT INTO outlines (id, project_id, volume, chapter_no, title, synopsis, role, suspense, twist, hook, foreshadow_ops, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    input.projectId,
    input.volume,
    input.chapterNo,
    input.title ?? '',
    input.synopsis ?? '',
    input.role ?? '',
    input.suspense ?? '',
    input.twist ?? 0,
    input.hook ?? '',
    input.foreshadowOps ?? '',
    input.status ?? 'draft',
    ts,
    ts
  )
  return mapOutline(db.prepare('SELECT * FROM outlines WHERE id = ?').get(id) as Row)
}

export function deleteOutline(id: string): void {
  getDb().prepare('DELETE FROM outlines WHERE id = ?').run(id)
}

type ChapterRow = {
  id: string
  outline_id: string
  project_id: string
  version: number
  content: string
  word_count: number
  status: string
  created_at: number
  updated_at: number
}

export function countWords(text: string): number {
  return text.replace(/\s/g, '').length
}

export function listChapterBriefs(projectId: string): ChapterBrief[] {
  const rows = getDb()
    .prepare(
      `SELECT o.*, c.id AS chapter_id, c.word_count AS wc, c.status AS chapter_status
       FROM outlines o LEFT JOIN chapters c ON c.outline_id = o.id
       WHERE o.project_id = ? ORDER BY o.volume, o.chapter_no`
    )
    .all(projectId) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    ...mapOutline(r),
    hasDraft: !!r.chapter_id,
    wordCount: (r.wc as number) ?? 0,
    chapterStatus: (r.chapter_status as string) ?? ''
  }))
}

export function getChapterByOutline(outlineId: string): Chapter | null {
  const r = getDb().prepare('SELECT * FROM chapters WHERE outline_id = ?').get(outlineId) as
    | ChapterRow
    | undefined
  if (!r) return null
  return {
    id: r.id,
    outlineId: r.outline_id,
    projectId: r.project_id,
    version: r.version,
    content: r.content,
    wordCount: r.word_count,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function saveChapter(args: {
  outlineId: string
  projectId: string
  content: string
  status?: string
}): Chapter {
  const db = getDb()
  const ts = now()
  const existing = db.prepare('SELECT * FROM chapters WHERE outline_id = ?').get(args.outlineId) as
    | ChapterRow
    | undefined
  const wc = countWords(args.content)
  if (existing) {
    db.prepare(
      'UPDATE chapters SET content = ?, word_count = ?, version = version + 1, status = COALESCE(?, status), updated_at = ? WHERE id = ?'
    ).run(args.content, wc, args.status ?? null, ts, existing.id)
  } else {
    const id = randomUUID()
    db.prepare(
      'INSERT INTO chapters (id, outline_id, project_id, version, content, word_count, status, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)'
    ).run(id, args.outlineId, args.projectId, args.content, wc, args.status ?? 'draft', ts, ts)
  }
  return getChapterByOutline(args.outlineId) as Chapter
}

export function getSummary(chapterId: string): ChapterSummary | null {
  const r = getDb().prepare('SELECT * FROM summaries WHERE chapter_id = ?').get(chapterId) as
    | { id: string; chapter_id: string; content: string; created_at: number }
    | undefined
  if (!r) return null
  try {
    const parsed = JSON.parse(r.content) as Omit<ChapterSummary, 'id' | 'chapterId' | 'createdAt'>
    return { id: r.id, chapterId: r.chapter_id, createdAt: r.created_at, ...parsed }
  } catch {
    return null
  }
}

export function saveSummary(
  chapterId: string,
  summary: Omit<ChapterSummary, 'id' | 'chapterId' | 'createdAt'>
): void {
  const db = getDb()
  const raw = JSON.stringify(summary)
  const existing = db.prepare('SELECT id FROM summaries WHERE chapter_id = ?').get(chapterId) as
    | { id: string }
    | undefined
  if (existing) {
    db.prepare('UPDATE summaries SET content = ? WHERE chapter_id = ?').run(raw, chapterId)
  } else {
    db.prepare(
      'INSERT INTO summaries (id, chapter_id, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(randomUUID(), chapterId, raw, now())
  }
}

interface ForeshadowRow {
  id: string
  project_id: string
  content: string
  planted_chapter: string
  status: string
  resolved_chapter: string
  planned_resolve: string
  priority: string
  created_at: number
  updated_at: number
}

function mapForeshadow(r: ForeshadowRow): Foreshadow {
  return {
    id: r.id,
    projectId: r.project_id,
    content: r.content,
    plantedChapter: r.planted_chapter ?? '',
    status: r.status ?? 'open',
    resolvedChapter: r.resolved_chapter ?? '',
    plannedResolve: r.planned_resolve ?? '',
    priority: r.priority ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function listForeshadows(projectId: string): Foreshadow[] {
  return getDb()
    .prepare('SELECT * FROM foreshadows WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId)
    .map((r) => mapForeshadow(r as unknown as ForeshadowRow))
}

export function saveForeshadow(input: ForeshadowInput & { id?: string }): Foreshadow {
  const db = getDb()
  const ts = now()
  if (input.id) {
    const cur = mapForeshadow(
      db.prepare('SELECT * FROM foreshadows WHERE id = ?').get(input.id) as unknown as ForeshadowRow
    )
    db.prepare(
      'UPDATE foreshadows SET content = ?, planted_chapter = ?, status = ?, resolved_chapter = ?, planned_resolve = ?, priority = ?, updated_at = ? WHERE id = ?'
    ).run(
      input.content,
      input.plantedChapter ?? cur.plantedChapter,
      input.status ?? cur.status,
      input.resolvedChapter ?? cur.resolvedChapter,
      input.plannedResolve ?? cur.plannedResolve,
      input.priority ?? cur.priority,
      ts,
      input.id
    )
  } else {
    const id = randomUUID()
    db.prepare(
      'INSERT INTO foreshadows (id, project_id, content, planted_chapter, status, resolved_chapter, planned_resolve, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      input.projectId,
      input.content,
      input.plantedChapter ?? '',
      input.status ?? 'open',
      input.resolvedChapter ?? '',
      input.plannedResolve ?? '',
      input.priority ?? '',
      ts,
      ts
    )
  }
  const row = input.id
    ? db.prepare('SELECT * FROM foreshadows WHERE id = ?').get(input.id)
    : db
        .prepare('SELECT * FROM foreshadows WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(input.projectId)
  return mapForeshadow(row as unknown as ForeshadowRow)
}

export function deleteForeshadow(id: string): void {
  getDb().prepare('DELETE FROM foreshadows WHERE id = ?').run(id)
}

export function getVolumeSummary(projectId: string, volume: number): VolumeSummary | null {
  const r = getDb()
    .prepare('SELECT * FROM volume_summaries WHERE project_id = ? AND volume = ?')
    .get(projectId, volume) as
    | { id: string; project_id: string; volume: number; summary: string; updated_at: number }
    | undefined
  if (!r) return null
  return { projectId: r.project_id, volume: r.volume, summary: r.summary, updatedAt: r.updated_at }
}

export function listVolumeSummaries(projectId: string): VolumeSummary[] {
  return (
    getDb()
      .prepare('SELECT * FROM volume_summaries WHERE project_id = ? ORDER BY volume')
      .all(projectId) as Array<{
      id: string
      project_id: string
      volume: number
      summary: string
      updated_at: number
    }>
  ).map((r) => ({
    projectId: r.project_id,
    volume: r.volume,
    summary: r.summary,
    updatedAt: r.updated_at
  }))
}

export function saveVolumeSummary(
  projectId: string,
  volume: number,
  summary: string
): VolumeSummary {
  const db = getDb()
  const ts = now()
  const existing = db
    .prepare('SELECT id FROM volume_summaries WHERE project_id = ? AND volume = ?')
    .get(projectId, volume) as { id: string } | undefined
  if (existing) {
    db.prepare('UPDATE volume_summaries SET summary = ?, updated_at = ? WHERE id = ?').run(
      summary,
      ts,
      existing.id
    )
  } else {
    db.prepare(
      'INSERT INTO volume_summaries (id, project_id, volume, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), projectId, volume, summary, ts, ts)
  }
  return getVolumeSummary(projectId, volume) as VolumeSummary
}
