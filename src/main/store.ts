import { randomUUID } from 'node:crypto'
import { splitTags } from '../shared/tags'
import type {
  Chapter,
  ChapterBrief,
  ChapterSummary,
  Character,
  CharacterInput,
  EntitySection,
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
import { mergeEntityCard, splitEntityCard } from './entityCard'

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
    styleSample: (r.style_sample as string) ?? '',
    targetWords: (r.target_words as number) ?? 0,
    status: (r.status as string) ?? 'active',
    wizardPlan: (r.wizard_plan as string) ?? '',
    agentInstructions: (r.agent_instructions as string) ?? '',
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
    relation: (r.relation as string) ?? '',
    state: (r.state as string) ?? '',
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

type SectionRow = {
  id: string
  character_id: string
  title: string
  content: string
  sort_key: number
  created_at: number
  updated_at: number
}

type WbSectionRow = {
  id: string
  worldbuild_id: string
  title: string
  content: string
  sort_key: number
  created_at: number
  updated_at: number
}

function mapSection(r: SectionRow): EntitySection {
  return {
    id: r.id,
    entityId: r.character_id,
    title: r.title ?? '',
    content: r.content ?? '',
    sortKey: r.sort_key ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function mapWbSection(r: WbSectionRow): EntitySection {
  return {
    id: r.id,
    entityId: r.worldbuild_id,
    title: r.title ?? '',
    content: r.content ?? '',
    sortKey: r.sort_key ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/** 为人物批量拼合并视图 card（分节是事实源，card 列恒空） */
function attachCards(db: ReturnType<typeof getDb>, chars: Character[]): Character[] {
  if (chars.length === 0) return chars
  const ids = chars.map((c) => c.id)
  const ph = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT * FROM character_sections WHERE character_id IN (${ph}) ORDER BY character_id, sort_key, created_at`
    )
    .all(...ids) as unknown as SectionRow[]
  const grouped = new Map<string, EntitySection[]>()
  for (const r of rows) {
    const arr = grouped.get(r.character_id)
    if (arr) arr.push(mapSection(r))
    else grouped.set(r.character_id, [mapSection(r)])
  }
  return chars.map((c) => {
    const sections = grouped.get(c.id) ?? []
    return {
      ...c,
      card: mergeEntityCard(
        `## ${c.name}${c.tags.trim() ? ` ${c.tags}` : ''}`,
        sections,
        c.relation
      )
    }
  })
}

/** 为世界观条目批量拼合并视图 content（分节是事实源，content 列恒空）；头格式对齐 worldbuilder 生成协议 `## [类型] 标题 #tags` */
function attachWbContents(
  db: ReturnType<typeof getDb>,
  entries: WorldbuildEntry[]
): WorldbuildEntry[] {
  if (entries.length === 0) return entries
  const ids = entries.map((e) => e.id)
  const ph = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT * FROM worldbuild_sections WHERE worldbuild_id IN (${ph}) ORDER BY worldbuild_id, sort_key, created_at`
    )
    .all(...ids) as unknown as WbSectionRow[]
  const grouped = new Map<string, EntitySection[]>()
  for (const r of rows) {
    const arr = grouped.get(r.worldbuild_id)
    if (arr) arr.push(mapWbSection(r))
    else grouped.set(r.worldbuild_id, [mapWbSection(r)])
  }
  return entries.map((e) => {
    const sections = grouped.get(e.id) ?? []
    const tags = e.tags.trim() ? ` ${e.tags}` : ''
    return {
      ...e,
      content: mergeEntityCard(`## [${e.category}] ${e.title}${tags}`, sections, e.relation)
    }
  })
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
    relation: (r.relation as string) ?? '',
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

function parseScenes(v: unknown): string[] {
  try {
    const arr: unknown = JSON.parse(String(v ?? '[]'))
    return Array.isArray(arr) ? arr.map((s) => String(s)).filter((s) => s.trim() !== '') : []
  } catch {
    return []
  }
}

function mapOutline(r: Row): OutlineItem {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    volume: r.volume as number,
    chapterNo: r.chapter_no as number,
    sortKey: (r.sort_key as number) ?? (r.chapter_no as number),
    title: (r.title as string) ?? '',
    synopsis: (r.synopsis as string) ?? '',
    scenes: parseScenes(r.scenes),
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
      'INSERT INTO projects (id, title, genre, style_guide, style_sample, target_words, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      input.title,
      input.genre ?? '',
      input.styleGuide ?? '',
      input.styleSample ?? '',
      input.targetWords ?? 0,
      ts,
      ts
    )
  return mapProject(getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row)
}

export function updateProject(id: string, input: Partial<ProjectInput>): void {
  const db = getDb()
  const cur = mapProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row)
  db.prepare(
    'UPDATE projects SET title = ?, genre = ?, style_guide = ?, style_sample = ?, target_words = ?, wizard_plan = ?, agent_instructions = ?, updated_at = ? WHERE id = ?'
  ).run(
    input.title ?? cur.title,
    input.genre ?? cur.genre,
    input.styleGuide ?? cur.styleGuide,
    input.styleSample ?? cur.styleSample,
    input.targetWords ?? cur.targetWords,
    input.wizardPlan ?? cur.wizardPlan,
    input.agentInstructions ?? cur.agentInstructions,
    now(),
    id
  )
}

export function deleteProject(id: string): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
}

export function listCharacters(projectId: string): Character[] {
  const db = getDb()
  const chars = (
    db
      .prepare('SELECT * FROM characters WHERE project_id = ? ORDER BY created_at')
      .all(projectId) as Row[]
  ).map(mapCharacter)
  return attachCards(db, chars)
}

export function getCharacter(id: string): Character | null {
  const row = getDb().prepare('SELECT * FROM characters WHERE id = ?').get(id) as Row | undefined
  if (!row) return null
  return attachCards(getDb(), [mapCharacter(row)])[0]
}

function replaceCharacterSectionsInner(
  db: ReturnType<typeof getDb>,
  characterId: string,
  sections: Array<{ title: string; content: string }>
): void {
  db.prepare('DELETE FROM character_sections WHERE character_id = ?').run(characterId)
  const ins = db.prepare(
    'INSERT INTO character_sections (id, character_id, title, content, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const ts = now()
  sections.forEach((s, i) => {
    ins.run(randomUUID(), characterId, s.title, s.content, i, ts, ts)
  })
}

export function saveCharacter(input: CharacterInput & { id?: string }): Character {
  const db = getDb()
  const ts = now()
  let targetId: string
  db.exec('BEGIN')
  try {
    if (input.id) {
      const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(input.id) as
        | Row
        | undefined
      if (!row) throw new Error(`人物不存在：${input.id}`)
      const cur = mapCharacter(row)
      db.prepare(
        'UPDATE characters SET name = ?, role = ?, tags = ?, relation = ?, state = ?, updated_at = ? WHERE id = ?'
      ).run(
        input.name,
        input.role ?? cur.role,
        input.tags ?? cur.tags,
        input.relation ?? cur.relation,
        input.state ?? cur.state,
        ts,
        input.id
      )
      targetId = input.id
    } else {
      targetId = randomUUID()
      db.prepare(
        'INSERT INTO characters (id, project_id, name, role, tags, relation, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        targetId,
        input.projectId,
        input.name,
        input.role ?? '',
        input.tags ?? '',
        input.relation ?? '',
        input.state ?? '',
        ts,
        ts
      )
    }
    // 分节写入：sections 全量替换优先；否则旧式 card 切分替换（两者都未传则不动）
    const sections =
      input.sections !== undefined
        ? input.sections.map((s) => ({ title: s.title, content: s.content }))
        : input.card !== undefined
          ? splitEntityCard(input.card).sections
          : undefined
    if (sections !== undefined) replaceCharacterSectionsInner(db, targetId, sections)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  const saved = mapCharacter(
    db.prepare('SELECT * FROM characters WHERE id = ?').get(targetId) as Row
  )
  return attachCards(db, [saved])[0]
}

export function getCharacterSections(characterId: string): EntitySection[] {
  return (
    getDb()
      .prepare(
        'SELECT * FROM character_sections WHERE character_id = ? ORDER BY sort_key, created_at'
      )
      .all(characterId) as unknown as SectionRow[]
  ).map(mapSection)
}

export function getCharacterSection(id: string): EntitySection | undefined {
  const row = getDb().prepare('SELECT * FROM character_sections WHERE id = ?').get(id) as unknown as
    | SectionRow
    | undefined
  return row ? mapSection(row) : undefined
}

export function saveCharacterSection(input: {
  characterId: string
  id?: string
  title: string
  content: string
}): EntitySection {
  const db = getDb()
  const ts = now()
  if (input.id) {
    const cur = getCharacterSections(input.characterId).find((s) => s.id === input.id)
    if (!cur) throw new Error('分节不存在或不属于该人物')
    db.prepare(
      'UPDATE character_sections SET title = ?, content = ?, updated_at = ? WHERE id = ?'
    ).run(input.title, input.content, ts, input.id)
  } else {
    const max = db
      .prepare('SELECT MAX(sort_key) AS m FROM character_sections WHERE character_id = ?')
      .get(input.characterId) as { m: number | null }
    db.prepare(
      'INSERT INTO character_sections (id, character_id, title, content, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), input.characterId, input.title, input.content, (max.m ?? -1) + 1, ts, ts)
  }
  db.prepare('UPDATE characters SET updated_at = ? WHERE id = ?').run(ts, input.characterId)
  const row = input.id
    ? db.prepare('SELECT * FROM character_sections WHERE id = ?').get(input.id)
    : (db
        .prepare(
          'SELECT * FROM character_sections WHERE character_id = ? ORDER BY sort_key DESC, created_at DESC LIMIT 1'
        )
        .get(input.characterId) as unknown as SectionRow)
  return mapSection(row as SectionRow)
}

export function deleteCharacterSections(characterId: string, ids: string[]): number {
  const db = getDb()
  const del = db.prepare('DELETE FROM character_sections WHERE character_id = ? AND id = ?')
  db.exec('BEGIN')
  try {
    let n = 0
    for (const id of ids) n += Number(del.run(characterId, id).changes)
    db.prepare('UPDATE characters SET updated_at = ? WHERE id = ?').run(now(), characterId)
    db.exec('COMMIT')
    return n
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** 事务批量覆盖既有分节（edit_text 定点修改用）：任一更新失败整体回滚 */
export function saveCharacterSectionsBatch(
  characterId: string,
  sections: Array<{ id: string; title: string; content: string }>
): void {
  const db = getDb()
  const ts = now()
  const upd = db.prepare(
    'UPDATE character_sections SET title = ?, content = ?, updated_at = ? WHERE id = ?'
  )
  db.exec('BEGIN')
  try {
    for (const s of sections) {
      if (upd.run(s.title, s.content, ts, s.id).changes === 0)
        throw new Error(`分节不存在或不属于该人物: ${s.id}`)
    }
    db.prepare('UPDATE characters SET updated_at = ? WHERE id = ?').run(ts, characterId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function deleteCharacter(id: string): void {
  getDb().prepare('DELETE FROM characters WHERE id = ?').run(id)
}

export function listWorldbuild(projectId: string): WorldbuildEntry[] {
  const db = getDb()
  const entries = (
    db
      .prepare('SELECT * FROM worldbuild WHERE project_id = ? ORDER BY category, created_at')
      .all(projectId) as Row[]
  ).map((r) => mapWorldbuild(r))
  return attachWbContents(db, entries)
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
    ['worldbuild', 'relation'],
    ['worldbuild_sections', 'content'],
    ['characters', 'relation'],
    ['character_sections', 'content'],
    ['outlines', 'synopsis'],
    ['chapters', 'content']
  ]
  const replace = (table: string, col: string, where: string): number => {
    // 表/列/WHERE 均来自硬编码 pairs，标题文本全部走占位符
    const r = db
      .prepare(
        `UPDATE ${table} SET ${col} = REPLACE(REPLACE(${col}, ?, ?), ?, ?) WHERE ${where} AND ${col} LIKE ?`
      )
      .run(`[[${o}|`, `[[${n}|`, `[[${o}]]`, `[[${n}]]`, projectId, like)
    return Number(r.changes)
  }
  for (const [table, col] of pairs) {
    // 两个 section 表无 project_id 列，经主表间接限定
    const where =
      table === 'character_sections'
        ? 'character_id IN (SELECT id FROM characters WHERE project_id = ?)'
        : table === 'worldbuild_sections'
          ? 'worldbuild_id IN (SELECT id FROM worldbuild WHERE project_id = ?)'
          : 'project_id = ?'
    changed += replace(table, col, where)
  }
  return changed
}

export function getWorldbuild(id: string): WorldbuildEntry | null {
  const row = getDb().prepare('SELECT * FROM worldbuild WHERE id = ?').get(id) as Row | undefined
  if (!row) return null
  return attachWbContents(getDb(), [mapWorldbuild(row)])[0]
}

function replaceWorldbuildSectionsInner(
  db: ReturnType<typeof getDb>,
  worldbuildId: string,
  sections: Array<{ title: string; content: string }>
): void {
  db.prepare('DELETE FROM worldbuild_sections WHERE worldbuild_id = ?').run(worldbuildId)
  const ins = db.prepare(
    'INSERT INTO worldbuild_sections (id, worldbuild_id, title, content, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const ts = now()
  sections.forEach((s, i) => {
    ins.run(randomUUID(), worldbuildId, s.title, s.content, i, ts, ts)
  })
}

export function saveWorldbuild(input: WorldbuildInput & { id?: string }): WorldbuildEntry {
  const db = getDb()
  const ts = now()
  let targetId: string
  db.exec('BEGIN')
  try {
    if (input.id) {
      const row = db.prepare('SELECT * FROM worldbuild WHERE id = ?').get(input.id) as
        | Row
        | undefined
      if (!row) throw new Error(`世界观条目不存在：${input.id}`)
      const cur = mapWorldbuild(row)
      if (input.title?.trim() && input.title.trim() !== cur.title.trim()) {
        propagateWikiRenames(db, input.projectId, cur.title, input.title)
      }
      db.prepare(
        'UPDATE worldbuild SET category = ?, title = ?, tags = ?, keys = ?, relation = ?, updated_at = ? WHERE id = ?'
      ).run(
        input.category,
        input.title,
        input.tags ?? cur.tags,
        input.keys ?? cur.keys,
        input.relation ?? cur.relation,
        ts,
        input.id
      )
      targetId = input.id
    } else {
      targetId = randomUUID()
      db.prepare(
        'INSERT INTO worldbuild (id, project_id, category, title, tags, keys, content, relation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        targetId,
        input.projectId,
        input.category,
        input.title,
        input.tags ?? '',
        input.keys ?? '',
        '',
        input.relation ?? '',
        ts,
        ts
      )
    }
    // 分节写入：sections 全量替换优先；否则旧式 content 整条切分替换（两者都未传则不动）
    const sections =
      input.sections !== undefined
        ? input.sections.map((s) => ({ title: s.title, content: s.content }))
        : input.content !== undefined
          ? splitEntityCard(input.content).sections
          : undefined
    if (sections !== undefined) replaceWorldbuildSectionsInner(db, targetId, sections)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  const saved = mapWorldbuild(
    db.prepare('SELECT * FROM worldbuild WHERE id = ?').get(targetId) as Row
  )
  return attachWbContents(db, [saved])[0]
}

export function getWorldbuildSections(worldbuildId: string): EntitySection[] {
  return (
    getDb()
      .prepare(
        'SELECT * FROM worldbuild_sections WHERE worldbuild_id = ? ORDER BY sort_key, created_at'
      )
      .all(worldbuildId) as unknown as WbSectionRow[]
  ).map(mapWbSection)
}

export function getWorldbuildSection(id: string): EntitySection | undefined {
  const row = getDb()
    .prepare('SELECT * FROM worldbuild_sections WHERE id = ?')
    .get(id) as unknown as WbSectionRow | undefined
  return row ? mapWbSection(row) : undefined
}

export function saveWorldbuildSection(input: {
  worldbuildId: string
  id?: string
  title: string
  content: string
}): EntitySection {
  const db = getDb()
  const ts = now()
  if (input.id) {
    const cur = getWorldbuildSections(input.worldbuildId).find((s) => s.id === input.id)
    if (!cur) throw new Error('分节不存在或不属于该世界观条目')
    db.prepare(
      'UPDATE worldbuild_sections SET title = ?, content = ?, updated_at = ? WHERE id = ?'
    ).run(input.title, input.content, ts, input.id)
  } else {
    const max = db
      .prepare('SELECT MAX(sort_key) AS m FROM worldbuild_sections WHERE worldbuild_id = ?')
      .get(input.worldbuildId) as { m: number | null }
    db.prepare(
      'INSERT INTO worldbuild_sections (id, worldbuild_id, title, content, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), input.worldbuildId, input.title, input.content, (max.m ?? -1) + 1, ts, ts)
  }
  db.prepare('UPDATE worldbuild SET updated_at = ? WHERE id = ?').run(ts, input.worldbuildId)
  const row = input.id
    ? db.prepare('SELECT * FROM worldbuild_sections WHERE id = ?').get(input.id)
    : (db
        .prepare(
          'SELECT * FROM worldbuild_sections WHERE worldbuild_id = ? ORDER BY sort_key DESC, created_at DESC LIMIT 1'
        )
        .get(input.worldbuildId) as unknown as WbSectionRow)
  return mapWbSection(row as WbSectionRow)
}

export function deleteWorldbuildSections(worldbuildId: string, ids: string[]): number {
  const db = getDb()
  const del = db.prepare('DELETE FROM worldbuild_sections WHERE worldbuild_id = ? AND id = ?')
  db.exec('BEGIN')
  try {
    let n = 0
    for (const id of ids) n += Number(del.run(worldbuildId, id).changes)
    db.prepare('UPDATE worldbuild SET updated_at = ? WHERE id = ?').run(now(), worldbuildId)
    db.exec('COMMIT')
    return n
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** 事务批量覆盖既有分节（edit_text 定点修改用）：任一更新失败整体回滚 */
export function saveWorldbuildSectionsBatch(
  worldbuildId: string,
  sections: Array<{ id: string; title: string; content: string }>
): void {
  const db = getDb()
  const ts = now()
  const upd = db.prepare(
    'UPDATE worldbuild_sections SET title = ?, content = ?, updated_at = ? WHERE id = ?'
  )
  db.exec('BEGIN')
  try {
    for (const s of sections) {
      if (upd.run(s.title, s.content, ts, s.id).changes === 0)
        throw new Error(`分节不存在或不属于该世界观条目: ${s.id}`)
    }
    db.prepare('UPDATE worldbuild SET updated_at = ? WHERE id = ?').run(ts, worldbuildId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
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

/**
 * 章号缓存重算：sort_key 是排序事实，chapter_no 由全局位置派生。
 * 临时把章号整体抬入高位段规避 UNIQUE(project_id, volume, chapter_no) 碰撞，再按位置稠密回写。
 */
function refreshStructure(projectId: string): void {
  const db = getDb()
  db.exec('BEGIN')
  try {
    db.prepare('UPDATE outlines SET chapter_no = chapter_no + 100000 WHERE project_id = ?').run(
      projectId
    )
    const rows = db
      .prepare(
        'SELECT id FROM outlines WHERE project_id = ? ORDER BY COALESCE(sort_key, 9e15), created_at, id'
      )
      .all(projectId) as Array<{ id: string }>
    const upd = db.prepare('UPDATE outlines SET sort_key = ?, chapter_no = ? WHERE id = ?')
    rows.forEach((r, i) => {
      upd.run(i + 1, i + 1, r.id)
    })
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function saveOutline(input: OutlineInput & { id?: string }): OutlineItem {
  const db = getDb()
  const ts = now()
  if (input.id) {
    const cur = mapOutline(db.prepare('SELECT * FROM outlines WHERE id = ?').get(input.id) as Row)
    db.prepare(
      'UPDATE outlines SET volume = ?, chapter_no = ?, title = ?, synopsis = ?, scenes = ?, role = ?, suspense = ?, twist = ?, hook = ?, foreshadow_ops = ?, status = ?, updated_at = ? WHERE id = ?'
    ).run(
      input.volume ?? cur.volume,
      input.chapterNo ?? cur.chapterNo,
      input.title ?? cur.title,
      input.synopsis ?? cur.synopsis,
      input.scenes ? JSON.stringify(input.scenes) : JSON.stringify(cur.scenes),
      input.role ?? cur.role,
      input.suspense ?? cur.suspense,
      input.twist ?? cur.twist,
      input.hook ?? cur.hook,
      input.foreshadowOps ?? cur.foreshadowOps,
      input.status ?? cur.status,
      ts,
      input.id
    )
    if (
      (input.volume !== undefined && input.volume !== cur.volume) ||
      (input.chapterNo !== undefined && input.chapterNo !== cur.chapterNo)
    ) {
      // 卷/章号变化 = 结构移动：以请求章号为排序槽位，随后按位置重算
      db.prepare('UPDATE outlines SET sort_key = ? WHERE id = ?').run(
        input.chapterNo ?? cur.chapterNo,
        input.id
      )
      refreshStructure(cur.projectId)
    }
    return mapOutline(db.prepare('SELECT * FROM outlines WHERE id = ?').get(input.id) as Row)
  }
  const id = randomUUID()
  db.prepare(
    'INSERT INTO outlines (id, project_id, volume, chapter_no, sort_key, title, synopsis, scenes, role, suspense, twist, hook, foreshadow_ops, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    input.projectId,
    input.volume,
    input.chapterNo,
    input.chapterNo,
    input.title ?? '',
    input.synopsis ?? '',
    JSON.stringify(input.scenes ?? []),
    input.role ?? '',
    input.suspense ?? '',
    input.twist ?? 0,
    input.hook ?? '',
    input.foreshadowOps ?? '',
    input.status ?? 'draft',
    ts,
    ts
  )
  refreshStructure(input.projectId)
  return mapOutline(db.prepare('SELECT * FROM outlines WHERE id = ?').get(id) as Row)
}

/** 结构操作：在指定章前插入（缺省目标 = 追加全书末尾），sort_key 取半步槽位后按位置稠密化 */
export function insertOutline(input: {
  projectId: string
  volume: number
  beforeOutlineId?: string
  afterOutlineId?: string
}): OutlineItem {
  const db = getDb()
  let sortKey: number
  if (input.beforeOutlineId) {
    const t = getOutline(input.beforeOutlineId)
    if (!t) throw new Error('插入目标章不存在')
    if (t.projectId !== input.projectId) throw new Error('插入目标章不属于当前项目')
    sortKey = t.sortKey - 0.5
  } else if (input.afterOutlineId) {
    const t = getOutline(input.afterOutlineId)
    if (!t) throw new Error('插入目标章不存在')
    if (t.projectId !== input.projectId) throw new Error('插入目标章不属于当前项目')
    sortKey = t.sortKey + 0.5
  } else {
    const max = db
      .prepare('SELECT MAX(sort_key) AS m FROM outlines WHERE project_id = ?')
      .get(input.projectId) as { m: number | null }
    sortKey = (max.m ?? 0) + 1
  }
  const id = randomUUID()
  const ts = now()
  db.prepare(
    'INSERT INTO outlines (id, project_id, volume, chapter_no, sort_key, title, synopsis, scenes, role, suspense, twist, hook, foreshadow_ops, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    input.projectId,
    input.volume,
    0,
    sortKey,
    '',
    '',
    '[]',
    '',
    '',
    0,
    '',
    '',
    'draft',
    ts,
    ts
  )
  refreshStructure(input.projectId)
  return mapOutline(db.prepare('SELECT * FROM outlines WHERE id = ?').get(id) as Row)
}

/** 结构操作：移动章节（可改卷）；目标章均缺省 = 移到全书末尾，卷变化不改变全局位置 */
export function moveOutline(input: {
  id: string
  volume?: number
  beforeOutlineId?: string
  afterOutlineId?: string
}): OutlineItem {
  const db = getDb()
  const cur = getOutline(input.id)
  if (!cur) throw new Error('章节不存在')
  let sortKey = cur.sortKey
  const targetId = input.beforeOutlineId ?? input.afterOutlineId
  if (targetId && targetId !== input.id) {
    const t = getOutline(targetId)
    if (!t) throw new Error('移动目标章不存在')
    if (t.projectId !== cur.projectId) throw new Error('移动目标章不属于当前项目')
    sortKey = input.beforeOutlineId ? t.sortKey - 0.5 : t.sortKey + 0.5
  }
  db.prepare('UPDATE outlines SET volume = ?, sort_key = ?, updated_at = ? WHERE id = ?').run(
    input.volume ?? cur.volume,
    sortKey,
    now(),
    input.id
  )
  refreshStructure(cur.projectId)
  return mapOutline(db.prepare('SELECT * FROM outlines WHERE id = ?').get(input.id) as Row)
}

export function deleteOutline(id: string): void {
  const db = getDb()
  const row = db.prepare('SELECT project_id, volume FROM outlines WHERE id = ?').get(id) as
    | { project_id: string; volume: number }
    | undefined
  db.prepare('DELETE FROM outlines WHERE id = ?').run(id)
  if (!row) return
  refreshStructure(row.project_id)
  // 大纲变动后，基于旧大纲写的衍生数据一并清除（正文/章摘要经 CASCADE 已删）
  clearVolumeSummary(row.project_id, row.volume)
  db.prepare("DELETE FROM embeddings WHERE kind = 'summary' AND ref_id = ?").run(id)
}

/**
 * 卷重写语义：清除该卷全部旧正文/章摘要/嵌入，并把该卷大纲状态降回草稿。
 * 大纲已重写即旧稿作废，写作页立刻回到「未写」；重写正文由用户在写作页主动触发，不再自动批量跑。
 * 返回清除的正文章数。
 */
export function clearVolumeContent(projectId: string, volume: number): number {
  const db = getDb()
  const outlineIds = (
    db
      .prepare('SELECT id FROM outlines WHERE project_id = ? AND volume = ?')
      .all(projectId, volume) as Array<{ id: string }>
  ).map((o) => o.id)
  if (outlineIds.length === 0) return 0
  const ph = outlineIds.map(() => '?').join(',')
  const chapterIds = (
    db.prepare(`SELECT id FROM chapters WHERE outline_id IN (${ph})`).all(...outlineIds) as Array<{
      id: string
    }>
  ).map((c) => c.id)
  if (chapterIds.length > 0) {
    const cph = chapterIds.map(() => '?').join(',')
    db.prepare(`DELETE FROM summaries WHERE chapter_id IN (${cph})`).run(...chapterIds)
    db.prepare(`DELETE FROM chapters WHERE id IN (${cph})`).run(...chapterIds)
  }
  db.prepare(`DELETE FROM embeddings WHERE kind = 'summary' AND ref_id IN (${ph})`).run(
    ...outlineIds
  )
  db.prepare(
    "UPDATE outlines SET status = 'draft' WHERE project_id = ? AND volume = ? AND status != 'draft'"
  ).run(projectId, volume)
  clearVolumeSummary(projectId, volume)
  return chapterIds.length
}

export function clearVolumeSummary(projectId: string, volume: number): void {
  getDb()
    .prepare('DELETE FROM volume_summaries WHERE project_id = ? AND volume = ?')
    .run(projectId, volume)
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

const CHAPTER_STATUS_RANK: Record<string, number> = {
  draft: 0,
  written: 1,
  polished: 2,
  approved: 3
}

/** 章节工作流状态只升不降（批量写完/返修后与大纲状态对齐；不覆盖已审定等更高状态） */
export function raiseChapterStatus(outlineId: string, status: string): void {
  const cur = getChapterByOutline(outlineId)
  if (!cur) return
  if ((CHAPTER_STATUS_RANK[status] ?? 0) <= (CHAPTER_STATUS_RANK[cur.status] ?? 0)) return
  getDb()
    .prepare('UPDATE chapters SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now(), cur.id)
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
  planted_outline_id: string
  planned_resolve_outline_id: string
  resolved_outline_id: string
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
    plantedOutlineId: r.planted_outline_id ?? '',
    plannedResolveOutlineId: r.planned_resolve_outline_id ?? '',
    resolvedOutlineId: r.resolved_outline_id ?? '',
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
      'UPDATE foreshadows SET content = ?, planted_chapter = ?, status = ?, resolved_chapter = ?, planned_resolve = ?, priority = ?, planted_outline_id = ?, planned_resolve_outline_id = ?, resolved_outline_id = ?, updated_at = ? WHERE id = ?'
    ).run(
      input.content,
      input.plantedChapter ?? cur.plantedChapter,
      input.status ?? cur.status,
      input.resolvedChapter ?? cur.resolvedChapter,
      input.plannedResolve ?? cur.plannedResolve,
      input.priority ?? cur.priority,
      input.plantedOutlineId ?? cur.plantedOutlineId,
      input.plannedResolveOutlineId ?? cur.plannedResolveOutlineId,
      input.resolvedOutlineId ?? cur.resolvedOutlineId,
      ts,
      input.id
    )
  } else {
    const id = randomUUID()
    db.prepare(
      'INSERT INTO foreshadows (id, project_id, content, planted_chapter, status, resolved_chapter, planned_resolve, priority, planted_outline_id, planned_resolve_outline_id, resolved_outline_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      input.projectId,
      input.content,
      input.plantedChapter ?? '',
      input.status ?? 'open',
      input.resolvedChapter ?? '',
      input.plannedResolve ?? '',
      input.priority ?? '',
      input.plantedOutlineId ?? '',
      input.plannedResolveOutlineId ?? '',
      input.resolvedOutlineId ?? '',
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
