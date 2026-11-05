import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataDir } from './paths.js'

/**
 * v2 数据库（node:sqlite，WAL）。
 * 分叉树模型（DECISIONS.md D1-D6）：
 * - books.active_line_id 指向激活线（写作永远在激活线尾；应用层保证，无 FK）
 * - lines: 主线 parent/fork 均空；分叉线 parent_line_id+fork_chapter_id
 * - cards/characters/foreshadows 挂 line——开新线时深拷贝，之后各线独立演化
 * - chapters: 线内 order_no 连续；parent_chapter_id 链到分叉点（跨线）
 * - memories: 滚动分层记忆的远端压缩层（最近章细记在 chapters.summary）
 */

let db: DatabaseSync | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  intro TEXT DEFAULT '',
  genre TEXT DEFAULT '',
  style_name TEXT DEFAULT '',
  style_sample TEXT DEFAULT '',
  style_notes TEXT DEFAULT '',
  target_words INTEGER DEFAULT 2000,
  redlines TEXT DEFAULT '[]',
  positive_words TEXT DEFAULT '[]',
  negative_words TEXT DEFAULT '[]',
  active_line_id TEXT DEFAULT '',
  archived INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  parent_line_id TEXT DEFAULT '',
  fork_chapter_id TEXT DEFAULT '',
  name TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  line_id TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  parent_chapter_id TEXT DEFAULT '',
  order_no INTEGER NOT NULL,
  title TEXT DEFAULT '',
  content TEXT DEFAULT '',
  word_count INTEGER DEFAULT 0,
  summary TEXT DEFAULT '',
  meta TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(line_id, order_no)
);

CREATE TABLE IF NOT EXISTS chapter_versions (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  reason TEXT DEFAULT '',
  word_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  kind TEXT DEFAULT 'custom',
  title TEXT NOT NULL,
  reader_text TEXT DEFAULT '',
  author_text TEXT DEFAULT '',
  reveal_plan TEXT DEFAULT '',
  pinned INTEGER DEFAULT 0,
  tags TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  card TEXT DEFAULT '{}',
  state TEXT DEFAULT '{}',
  relations TEXT DEFAULT '[]',
  pinned INTEGER DEFAULT 0,
  tags TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS foreshadows (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT DEFAULT '',
  planted_chapter_id TEXT DEFAULT '',
  planned_chapter_id TEXT DEFAULT '',
  resolved_chapter_id TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  priority INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  line_id TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  from_order INTEGER NOT NULL,
  to_order INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_id TEXT DEFAULT '',
  role TEXT NOT NULL,
  content TEXT DEFAULT '',
  meta TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT DEFAULT 'queued',
  step TEXT DEFAULT '',
  payload TEXT DEFAULT '{}',
  error TEXT DEFAULT '',
  chapter_id TEXT DEFAULT '',
  watchdog_at INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chapters_line ON chapters(line_id, order_no);
CREATE INDEX IF NOT EXISTS idx_versions_chapter ON chapter_versions(chapter_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cards_line ON cards(line_id, kind);
CREATE INDEX IF NOT EXISTS idx_characters_line ON characters(line_id);
CREATE INDEX IF NOT EXISTS idx_foreshadows_line ON foreshadows(line_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_line ON memories(line_id, from_order);
CREATE INDEX IF NOT EXISTS idx_messages_book ON messages(book_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_book ON jobs(book_id, created_at);
`

export function getDb(): DatabaseSync {
  if (db) return db
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  db = new DatabaseSync(join(dir, 'novel.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/** 列迁移：老库补新列（幂等） */
function migrate(d: DatabaseSync): void {
  const cols = new Set(
    (d.prepare("PRAGMA table_info('books')").all() as { name: string }[]).map((c) => c.name)
  )
  if (!cols.has('positive_words'))
    d.exec("ALTER TABLE books ADD COLUMN positive_words TEXT DEFAULT '[]'")
  if (!cols.has('negative_words'))
    d.exec("ALTER TABLE books ADD COLUMN negative_words TEXT DEFAULT '[]'")
}

/** 灾难恢复快照（删书/删线前调用，D4） */
export function snapshotDb(tag: string): string {
  const d = getDb()
  const file = join(
    dataDir(),
    `backup-${tag}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.db`
  )
  d.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`)
  return file
}
