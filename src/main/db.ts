import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'

let db: DatabaseSync | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  genre TEXT DEFAULT '',
  style_guide TEXT DEFAULT '',
  target_words INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  card TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS worldbuild (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT DEFAULT '其他',
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  keys TEXT DEFAULT '',
  relation TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS worldbuild_types (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, name)
);
CREATE TABLE IF NOT EXISTS outlines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  volume INTEGER NOT NULL DEFAULT 1,
  chapter_no INTEGER NOT NULL,
  sort_key REAL,
  title TEXT DEFAULT '',
  synopsis TEXT DEFAULT '',
  status TEXT DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, volume, chapter_no)
);
CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  outline_id TEXT NOT NULL UNIQUE REFERENCES outlines(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT DEFAULT '',
  word_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL UNIQUE REFERENCES chapters(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS foreshadows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  planted_chapter TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  resolved_chapter TEXT DEFAULT '',
  planned_resolve TEXT DEFAULT '',
  priority TEXT DEFAULT '',
  planted_outline_id TEXT DEFAULT '',
  planned_resolve_outline_id TEXT DEFAULT '',
  resolved_outline_id TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS volume_summaries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  volume INTEGER NOT NULL,
  summary TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, volume)
);
CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  vec BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_volume_summaries_project ON volume_summaries(project_id, volume);
CREATE INDEX IF NOT EXISTS idx_embeddings_project ON embeddings(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_characters_project ON characters(project_id);
CREATE INDEX IF NOT EXISTS idx_worldbuild_project ON worldbuild(project_id);
CREATE INDEX IF NOT EXISTS idx_outlines_project ON outlines(project_id, volume, chapter_no);
CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id);
CREATE INDEX IF NOT EXISTS idx_foreshadows_project ON foreshadows(project_id);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_events (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id, seq);
`

export function getDb(): DatabaseSync {
  if (db) return db
  const dataDir = join(app.getPath('userData'), 'data')
  mkdirSync(dataDir, { recursive: true })
  db = new DatabaseSync(join(dataDir, 'novel.db'))
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

function migrate(d: DatabaseSync): void {
  const cols = d.prepare('PRAGMA table_info(worldbuild)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'tags')) {
    d.exec("ALTER TABLE worldbuild ADD COLUMN tags TEXT DEFAULT ''")
  }
  if (!cols.some((c) => c.name === 'keys')) {
    d.exec("ALTER TABLE worldbuild ADD COLUMN keys TEXT DEFAULT ''")
  }
  if (!cols.some((c) => c.name === 'relation')) {
    d.exec("ALTER TABLE worldbuild ADD COLUMN relation TEXT DEFAULT ''")
  }
  const typeCols = d.prepare('PRAGMA table_info(worldbuild_types)').all() as Array<{ name: string }>
  if (!typeCols.some((c) => c.name === 'priority')) {
    d.exec('ALTER TABLE worldbuild_types ADD COLUMN priority REAL NOT NULL DEFAULT 100')
    d.exec(
      "UPDATE worldbuild_types SET priority = CASE name WHEN '地理' THEN 10 WHEN '势力' THEN 20 WHEN '历史' THEN 30 WHEN '力量体系' THEN 40 WHEN '物品' THEN 50 WHEN '其他' THEN 10000 ELSE 100 END"
    )
  }
  const outlineCols = d.prepare('PRAGMA table_info(outlines)').all() as Array<{ name: string }>
  if (!outlineCols.some((c) => c.name === 'role')) {
    d.exec("ALTER TABLE outlines ADD COLUMN role TEXT DEFAULT ''")
    d.exec("ALTER TABLE outlines ADD COLUMN suspense TEXT DEFAULT ''")
    d.exec('ALTER TABLE outlines ADD COLUMN twist INTEGER DEFAULT 0')
    d.exec("ALTER TABLE outlines ADD COLUMN hook TEXT DEFAULT ''")
    d.exec("ALTER TABLE outlines ADD COLUMN foreshadow_ops TEXT DEFAULT ''")
  }
  if (!outlineCols.some((c) => c.name === 'scenes')) {
    d.exec("ALTER TABLE outlines ADD COLUMN scenes TEXT DEFAULT '[]'")
  }
  if (!outlineCols.some((c) => c.name === 'sort_key')) {
    d.exec('ALTER TABLE outlines ADD COLUMN sort_key REAL')
    // 排序事实初始化：按既有 (volume, chapter_no) 序稠密化 1..n，此后章号由位置派生
    d.exec(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY project_id ORDER BY volume, chapter_no, created_at, id
        ) AS rn
        FROM outlines
      )
      UPDATE outlines SET sort_key = (SELECT rn FROM ranked WHERE ranked.id = outlines.id)
    `)
  }
  const charCols = d.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>
  if (!charCols.some((c) => c.name === 'state')) {
    d.exec("ALTER TABLE characters ADD COLUMN state TEXT DEFAULT ''")
  }
  const foreCols = d.prepare('PRAGMA table_info(foreshadows)').all() as Array<{ name: string }>
  if (!foreCols.some((c) => c.name === 'planned_resolve')) {
    d.exec("ALTER TABLE foreshadows ADD COLUMN planned_resolve TEXT DEFAULT ''")
    d.exec("ALTER TABLE foreshadows ADD COLUMN priority TEXT DEFAULT ''")
  }
  if (!foreCols.some((c) => c.name === 'planted_outline_id')) {
    d.exec("ALTER TABLE foreshadows ADD COLUMN planted_outline_id TEXT DEFAULT ''")
    d.exec("ALTER TABLE foreshadows ADD COLUMN planned_resolve_outline_id TEXT DEFAULT ''")
    d.exec("ALTER TABLE foreshadows ADD COLUMN resolved_outline_id TEXT DEFAULT ''")
    backfillForeOutlineIds(d)
  }
  const projCols = d.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
  if (!projCols.some((c) => c.name === 'wizard_plan')) {
    d.exec("ALTER TABLE projects ADD COLUMN wizard_plan TEXT DEFAULT ''")
  }
  if (!projCols.some((c) => c.name === 'agent_instructions')) {
    d.exec("ALTER TABLE projects ADD COLUMN agent_instructions TEXT DEFAULT ''")
  }
  if (!projCols.some((c) => c.name === 'style_sample')) {
    d.exec("ALTER TABLE projects ADD COLUMN style_sample TEXT DEFAULT ''")
  }
}

/** 伏笔章号文本 → 大纲 uid 存量回填：只填空列，解析失败保持空（展示层回退旧文本） */
function backfillForeOutlineIds(d: DatabaseSync): void {
  const outlines = d
    .prepare('SELECT id, project_id, volume, chapter_no FROM outlines ORDER BY volume, chapter_no')
    .all() as Array<{ id: string; project_id: string; volume: number; chapter_no: number }>
  const byNo = new Map<string, Map<number, string>>()
  const volNos = new Map<string, number[]>()
  for (const o of outlines) {
    let m = byNo.get(o.project_id)
    if (!m) {
      m = new Map()
      byNo.set(o.project_id, m)
    }
    // 同项目重复章号取最小卷（章号应为全书连续，重复属脏数据，兜底取首个）
    if (!m.has(o.chapter_no)) m.set(o.chapter_no, o.id)
    const vk = `${o.project_id}:${o.volume}`
    const arr = volNos.get(vk)
    if (arr) arr.push(o.chapter_no)
    else volNos.set(vk, [o.chapter_no])
  }
  const volPattern = /第\s*(\d+)\s*卷\s*(\d+)\s*(?:[-–—~～至到]\s*\d+)?\s*章/
  const rangePattern = /第\s*(\d+)\s*[-–—~～至到]\s*\d+\s*章/
  const plainPattern = /第\s*(\d+)\s*章/
  const resolve = (projectId: string, text: string): string => {
    let vol: number | null = null
    let no = 0
    const vm = volPattern.exec(text)
    if (vm) {
      vol = Number(vm[1])
      no = Number(vm[2])
    } else {
      const rm = rangePattern.exec(text) ?? plainPattern.exec(text)
      if (!rm) return ''
      no = Number(rm[1])
    }
    if (!no || Number.isNaN(no)) return ''
    if (vol !== null) {
      const arr = (volNos.get(`${projectId}:${vol}`) ?? []).filter((n) => n >= no)
      if (arr.length === 0) return ''
      return byNo.get(projectId)?.get(Math.min(...arr)) ?? ''
    }
    return byNo.get(projectId)?.get(no) ?? ''
  }
  const rows = d
    .prepare(
      'SELECT id, project_id, planted_chapter, planned_resolve, resolved_chapter FROM foreshadows'
    )
    .all() as Array<{
    id: string
    project_id: string
    planted_chapter: string | null
    planned_resolve: string | null
    resolved_chapter: string | null
  }>
  const upd = d.prepare(
    'UPDATE foreshadows SET planted_outline_id = ?, planned_resolve_outline_id = ?, resolved_outline_id = ? WHERE id = ?'
  )
  for (const r of rows) {
    const planted = r.planted_chapter ? resolve(r.project_id, r.planted_chapter) : ''
    const planned = r.planned_resolve ? resolve(r.project_id, r.planned_resolve) : ''
    const resolved = r.resolved_chapter ? resolve(r.project_id, r.resolved_chapter) : ''
    if (planted || planned || resolved) upd.run(planted, planned, resolved, r.id)
  }
}
