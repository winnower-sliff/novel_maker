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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_characters_project ON characters(project_id);
CREATE INDEX IF NOT EXISTS idx_worldbuild_project ON worldbuild(project_id);
CREATE INDEX IF NOT EXISTS idx_outlines_project ON outlines(project_id, volume, chapter_no);
CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id);
CREATE INDEX IF NOT EXISTS idx_foreshadows_project ON foreshadows(project_id);
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
    d.exec('ALTER TABLE worldbuild ADD COLUMN tags TEXT DEFAULT \'\'')
  }
  const typeCols = d.prepare('PRAGMA table_info(worldbuild_types)').all() as Array<{ name: string }>
  if (!typeCols.some((c) => c.name === 'priority')) {
    d.exec('ALTER TABLE worldbuild_types ADD COLUMN priority REAL NOT NULL DEFAULT 100')
    d.exec(
      "UPDATE worldbuild_types SET priority = CASE name WHEN '地理' THEN 10 WHEN '势力' THEN 20 WHEN '历史' THEN 30 WHEN '力量体系' THEN 40 WHEN '物品' THEN 50 WHEN '其他' THEN 10000 ELSE 100 END"
    )
  }
}
