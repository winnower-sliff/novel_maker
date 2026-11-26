import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BackupEntry } from '../shared/types.js'
import { dataDir } from './paths.js'

/**
 * v2 数据库（node:sqlite，WAL）。
 * 分叉树模型（DECISIONS.md D1-D6）：
 * - books.active_line_id 指向激活线（写作永远在激活线尾；应用层保证，无 FK）
 * - lines: 主线 parent/fork 均空；分叉线 parent_line_id+fork_chapter_id
 * - cards/characters/foreshadows 挂 line——开新线时深拷贝，之后各线独立演化
 * - chapters: 线内 order_no 连续；parent_chapter_id 链到分叉点（跨线）
 * - memories: 前情梗概（kind=running，每线一行，新章入书后合并更新，last_chapter_id 记覆盖到的最后一章）；
 *   kind=legacy 是旧的逐章压缩块，只读保留；最近章细记在 chapters.summary
 */

let db: DatabaseSync | null = null

/** 表结构版本（PRAGMA user_version）：改 SCHEMA 或 migrate 时 +1，老库升级前会自动留快照 */
// 2：memories 加 kind / last_chapter_id（前情梗概改为合并式）
const SCHEMA_VERSION = 2

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
  plan_mode INTEGER DEFAULT 0,
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
  fork_order INTEGER NOT NULL DEFAULT -1,
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
  data TEXT DEFAULT '{}',
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
  data TEXT DEFAULT '{}',
  state TEXT DEFAULT '{}',
  relations TEXT DEFAULT '[]',
  pinned INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
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
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'legacy',
  last_chapter_id TEXT NOT NULL DEFAULT ''
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

CREATE TABLE IF NOT EXISTS samples (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  chars INTEGER DEFAULT 0,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sample_sections (
  id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  chars INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chapters_line ON chapters(line_id, order_no);
CREATE INDEX IF NOT EXISTS idx_versions_chapter ON chapter_versions(chapter_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cards_line ON cards(line_id, kind);
CREATE INDEX IF NOT EXISTS idx_characters_line ON characters(line_id);
CREATE INDEX IF NOT EXISTS idx_foreshadows_line ON foreshadows(line_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_line ON memories(line_id, from_order);
CREATE INDEX IF NOT EXISTS idx_messages_book ON messages(book_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_book ON jobs(book_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sections_sample ON sample_sections(sample_id, start);
`

export function getDb(): DatabaseSync {
  if (db) return db
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  db = new DatabaseSync(join(dir, 'novel.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // 老库升级前留一份：列迁移不可逆，出问题还能回到升级前
  if (schemaIsOlder(db)) {
    try {
      console.log(`[db] 数据库结构升级，已留升级前快照：${snapshotDb('pre-migrate')}`)
    } catch (e) {
      console.error('[db] 升级前快照失败，继续升级', e)
    }
  }
  db.exec(SCHEMA)
  migrate(db)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  return db
}

/** 关闭连接（恢复备份要换库文件时用；下次 getDb 重新打开） */
export function closeDb(): void {
  try {
    db?.close()
  } finally {
    db = null
    epoch++
  }
}

let epoch = 0

/** 库被换过几次（恢复备份会 closeDb 再重开）：后台任务写库前比对，别把换库前算出的结果写进换库后的库 */
export function dbEpoch(): number {
  return epoch
}

function schemaIsOlder(d: DatabaseSync): boolean {
  const hasBooks = d
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'books'")
    .get()
  if (!hasBooks) return false
  const row = d.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version < SCHEMA_VERSION
}

/** 列迁移：老库补新列（幂等） */
function migrate(d: DatabaseSync): void {
  const tableCols = (table: string) =>
    new Set(
      (d.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]).map((c) => c.name)
    )
  const cols = tableCols('books')
  if (!cols.has('positive_words'))
    d.exec("ALTER TABLE books ADD COLUMN positive_words TEXT DEFAULT '[]'")
  if (!cols.has('negative_words'))
    d.exec("ALTER TABLE books ADD COLUMN negative_words TEXT DEFAULT '[]'")
  if (!cols.has('plan_mode')) d.exec('ALTER TABLE books ADD COLUMN plan_mode INTEGER DEFAULT 0')
  // 草稿书（用户决策：点「开新书」后没产生任何用户对话的书不算书，自动清理）
  if (!cols.has('draft')) d.exec('ALTER TABLE books ADD COLUMN draft INTEGER NOT NULL DEFAULT 0')
  if (!cols.has('style_sample_source'))
    d.exec("ALTER TABLE books ADD COLUMN style_sample_source TEXT DEFAULT ''")
  if (!cols.has('sample_sources')) {
    d.exec("ALTER TABLE books ADD COLUMN sample_sources TEXT DEFAULT '[]'")
    // 旧单值绑定搬进新数组（《新书》→少年阿宾 这类存量）
    d.exec(
      "UPDATE books SET sample_sources = json_array(style_sample_source) WHERE style_sample_source IS NOT NULL AND style_sample_source != ''"
    )
  }
  // 设定卡结构化数据（对象数组渲染成表格）
  if (!tableCols('cards').has('data')) d.exec("ALTER TABLE cards ADD COLUMN data TEXT DEFAULT '{}'")
  // 人设卡平铺（用户决策：card 拆成 tags+data，冷热分离）：旧 card 列整体改名 data，内容原样保留
  const charCols = tableCols('characters')
  if (charCols.has('card') && !charCols.has('data'))
    d.exec('ALTER TABLE characters RENAME COLUMN card TO data')
  if (!charCols.has('tags')) d.exec("ALTER TABLE characters ADD COLUMN tags TEXT DEFAULT '[]'")
  // 分叉点序号（-1=未记录）：分叉点章日后被删时，子线靠它保住更早的祖先章
  if (!tableCols('lines').has('fork_order'))
    d.exec('ALTER TABLE lines ADD COLUMN fork_order INTEGER NOT NULL DEFAULT -1')
  d.exec(
    `UPDATE lines SET fork_order = COALESCE((SELECT order_no FROM chapters WHERE id = lines.fork_chapter_id), fork_order)
     WHERE fork_order = -1 AND fork_chapter_id != ''`
  )
  // 前情梗概改为合并式：kind 区分旧的逐章压缩块（legacy，存量行默认值，只读保留）与每线一行的合并梗概（running）；
  // last_chapter_id 记梗概覆盖到的最后一章——按 id 定位，分叉线里章序号从 1 重排，不能用 order_no 当锚
  const memCols = tableCols('memories')
  if (!memCols.has('kind'))
    d.exec("ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy'")
  if (!memCols.has('last_chapter_id'))
    d.exec("ALTER TABLE memories ADD COLUMN last_chapter_id TEXT NOT NULL DEFAULT ''")
}

/** 灾难恢复快照（删书/删线前调用，D4）。VACUUM INTO 不覆盖已存在文件——文件名带时分秒，同秒冲突加序号 */
export function snapshotDb(tag: string): string {
  const d = getDb()
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  let file = join(dataDir(), `backup-${tag}-${stamp}.db`)
  for (let i = 2; existsSync(file); i++) file = join(dataDir(), `backup-${tag}-${stamp}-${i}.db`)
  d.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`)
  try {
    pruneBackups()
  } catch (e) {
    console.error('[db] 清理旧快照失败', e)
  }
  return file
}

// ── 备份清单与保留策略 ───────────────────────────────────────────────────────

const DAILY_RE = /^backup-daily-(\d{8})-(\d{6})(?:-(\d+))?\.db\.gz$/
const OP_RE = /^backup-(?!daily-)(.+)-(\d{8})-(\d{6})(?:-(\d+))?\.db$/
/** 每次删除操作自动留的快照：数量多、价值低，只留最近一批。手动备份/升级前/恢复前的不在此列，永不自动清理 */
const PRUNABLE_TAG = /^(del-|card-|char-|book-|line-|fore-)/
const OP_KEEP = 30
const DAILY_KEEP_DAYS = 7
const DAILY_BUCKET_DAYS = 7
const DAILY_BUCKETS = 8

function backupEntry(
  name: string,
  kind: BackupEntry['kind'],
  tag: string | undefined,
  day: string | undefined,
  time: string | undefined,
  seq: string | undefined
): BackupEntry | null {
  if (!tag || !day || !time) return null
  let size = 0
  try {
    size = statSync(join(dataDir(), name)).size
  } catch {
    return null
  }
  const at = new Date(
    Number(day.slice(0, 4)),
    Number(day.slice(4, 6)) - 1,
    Number(day.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6))
  ).getTime()
  return {
    name,
    kind,
    tag,
    size,
    at,
    key: `${day}${time}.${String(Number(seq ?? 1)).padStart(4, '0')}`
  }
}

/** 数据目录里的全部备份，新 → 旧 */
export function listBackups(): BackupEntry[] {
  const dir = dataDir()
  if (!existsSync(dir)) return []
  const out: BackupEntry[] = []
  for (const name of readdirSync(dir)) {
    const daily = DAILY_RE.exec(name)
    const op = daily ? null : OP_RE.exec(name)
    const e = daily
      ? backupEntry(name, 'daily', 'daily', daily[1], daily[2], daily[3])
      : op
        ? backupEntry(name, 'op', op[1], op[2], op[3], op[4])
        : null
    if (e) out.push(e)
  }
  return out.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
}

/**
 * 清理旧备份，返回被删的文件名。
 * 删除操作快照只留最近 OP_KEEP 个；每日备份最近 7 天全留，更早的每 7 天留 1 个、最多 8 个。
 */
export function pruneBackups(): string[] {
  const removed: string[] = []
  const now = Date.now()
  const seenBuckets = new Set<number>()
  let ops = 0
  for (const e of listBackups()) {
    let drop = false
    if (e.kind === 'op') {
      if (!PRUNABLE_TAG.test(e.tag)) continue
      ops += 1
      drop = ops > OP_KEEP
    } else {
      const ageDays = (now - e.at) / 86_400_000
      if (ageDays > DAILY_KEEP_DAYS) {
        const bucket = Math.floor(ageDays / DAILY_BUCKET_DAYS)
        drop = seenBuckets.has(bucket) || seenBuckets.size >= DAILY_BUCKETS
        if (!drop) seenBuckets.add(bucket)
      }
    }
    if (drop) {
      rmSync(join(dataDir(), e.name))
      removed.push(e.name)
    }
  }
  return removed
}
