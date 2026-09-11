import { randomUUID } from 'node:crypto'
import type {
  Chapter,
  ChapterBrief,
  ChapterSummary,
  Character,
  CharacterInput,
  Foreshadow,
  ForeshadowInput,
  OutlineItem,
  OutlineStatus,
  OutlineInput,
  Project,
  ProjectInput,
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
    'UPDATE projects SET title = ?, genre = ?, style_guide = ?, target_words = ?, updated_at = ? WHERE id = ?'
  ).run(
    input.title ?? cur.title,
    input.genre ?? cur.genre,
    input.styleGuide ?? cur.styleGuide,
    input.targetWords ?? cur.targetWords,
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
    db.prepare(
      'UPDATE characters SET name = ?, role = ?, tags = ?, card = ?, updated_at = ? WHERE id = ?'
    ).run(input.name, input.role ?? '', input.tags ?? '', input.card ?? '', ts, input.id)
    return mapCharacter(db.prepare('SELECT * FROM characters WHERE id = ?').get(input.id) as Row)
  }
  const id = randomUUID()
  db.prepare(
    'INSERT INTO characters (id, project_id, name, role, tags, card, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, input.projectId, input.name, input.role ?? '', input.tags ?? '', input.card ?? '', ts, ts)
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

export function saveWorldbuild(input: WorldbuildInput & { id?: string }): WorldbuildEntry {
  const db = getDb()
  const ts = now()
  if (input.id) {
    db.prepare(
      'UPDATE worldbuild SET category = ?, title = ?, content = ?, updated_at = ? WHERE id = ?'
    ).run(input.category, input.title, input.content ?? '', ts, input.id)
    return mapWorldbuild(db.prepare('SELECT * FROM worldbuild WHERE id = ?').get(input.id) as Row)
  }
  const id = randomUUID()
  db.prepare(
    'INSERT INTO worldbuild (id, project_id, category, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, input.projectId, input.category, input.title, input.content ?? '', ts, ts)
  return mapWorldbuild(db.prepare('SELECT * FROM worldbuild WHERE id = ?').get(id) as Row)
}

export function deleteWorldbuild(id: string): void {
  getDb().prepare('DELETE FROM worldbuild WHERE id = ?').run(id)
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
    db.prepare(
      'UPDATE outlines SET volume = ?, chapter_no = ?, title = ?, synopsis = ?, status = ?, updated_at = ? WHERE id = ?'
    ).run(input.volume, input.chapterNo, input.title ?? '', input.synopsis ?? '', input.status ?? 'draft', ts, input.id)
    return mapOutline(db.prepare('SELECT * FROM outlines WHERE id = ?').get(input.id) as Row)
  }
  const id = randomUUID()
  db.prepare(
    'INSERT INTO outlines (id, project_id, volume, chapter_no, title, synopsis, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    input.projectId,
    input.volume,
    input.chapterNo,
    input.title ?? '',
    input.synopsis ?? '',
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
  const existing = db
    .prepare('SELECT * FROM chapters WHERE outline_id = ?')
    .get(args.outlineId) as ChapterRow | undefined
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

export function saveSummary(chapterId: string, summary: Omit<ChapterSummary, 'id' | 'chapterId' | 'createdAt'>): void {
  const db = getDb()
  const raw = JSON.stringify(summary)
  const existing = db.prepare('SELECT id FROM summaries WHERE chapter_id = ?').get(chapterId) as
    | { id: string }
    | undefined
  if (existing) {
    db.prepare('UPDATE summaries SET content = ? WHERE chapter_id = ?').run(raw, chapterId)
  } else {
    db.prepare('INSERT INTO summaries (id, chapter_id, content, created_at) VALUES (?, ?, ?, ?)').run(
      randomUUID(),
      chapterId,
      raw,
      now()
    )
  }
}

export function listForeshadows(projectId: string): Foreshadow[] {
  return getDb()
    .prepare('SELECT * FROM foreshadows WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId)
    .map((r) => {
      const row = r as Record<string, unknown>
      return {
        id: row.id as string,
        projectId: row.project_id as string,
        content: row.content as string,
        plantedChapter: (row.planted_chapter as string) ?? '',
        status: (row.status as string) ?? 'open',
        resolvedChapter: (row.resolved_chapter as string) ?? '',
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number
      }
    })
}

export function saveForeshadow(input: ForeshadowInput & { id?: string }): Foreshadow {
  const db = getDb()
  const ts = now()
  if (input.id) {
    db.prepare(
      'UPDATE foreshadows SET content = ?, planted_chapter = ?, status = ?, resolved_chapter = ?, updated_at = ? WHERE id = ?'
    ).run(input.content, input.plantedChapter ?? '', input.status ?? 'open', input.resolvedChapter ?? '', ts, input.id)
  } else {
    const id = randomUUID()
    db.prepare(
      'INSERT INTO foreshadows (id, project_id, content, planted_chapter, status, resolved_chapter, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.projectId, input.content, input.plantedChapter ?? '', input.status ?? 'open', input.resolvedChapter ?? '', ts, ts)
  }
  const row = input.id
    ? db.prepare('SELECT * FROM foreshadows WHERE id = ?').get(input.id)
    : db.prepare('SELECT * FROM foreshadows WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(input.projectId)
  const r = row as Record<string, unknown>
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    content: r.content as string,
    plantedChapter: (r.planted_chapter as string) ?? '',
    status: (r.status as string) ?? 'open',
    resolvedChapter: (r.resolved_chapter as string) ?? '',
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

export function deleteForeshadow(id: string): void {
  getDb().prepare('DELETE FROM foreshadows WHERE id = ?').run(id)
}
