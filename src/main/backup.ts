import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip, gunzipSync } from 'node:zlib'
import { closeDb, getDb, listBackups, pruneBackups, snapshotDb } from './db.js'
import { dataDir } from './paths.js'

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * 每日备份：今天还没备份过才做一份（gzip 压缩——范文全文占库的大头且基本不变）。
 * 失败只记日志、返回 null，下次启动再试；绝不影响写作主链路。
 */
export async function dailyBackup(): Promise<string | null> {
  const dir = dataDir()
  if (!existsSync(join(dir, 'novel.db'))) return null
  if ((getDb().prepare('SELECT count(*) AS n FROM books').get() as { n: number }).n === 0)
    return null
  const now = new Date()
  const today = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  if (listBackups().some((e) => e.kind === 'daily' && e.key.startsWith(today))) return null

  const raw = snapshotDb('daily')
  const gz = `${raw}.gz`
  try {
    await pipeline(createReadStream(raw), createGzip(), createWriteStream(gz))
  } catch (e) {
    // 半截文件必须清掉，否则下次会把它当成「今天已备份」
    rmSync(gz, { force: true })
    rmSync(raw, { force: true })
    console.error('[backup] 每日备份失败', e)
    return null
  }
  rmSync(raw)
  pruneBackups()
  console.log(`[backup] 每日备份完成：${basename(gz)}`)
  return gz
}

const NAME_RE = /^backup-[A-Za-z0-9-]+\.db(\.gz)?$/
const DB_FILES = ['novel.db', 'novel.db-wal', 'novel.db-shm']

/**
 * 用一份备份覆盖当前数据库。恢复前先给现在的数据留一份（pre-restore）。
 * 备份用不了（文件损坏等）时原样换回，不留半残状态。
 */
export function restoreBackup(name: string): { books: number; safeguard: string } {
  if (!NAME_RE.test(name)) throw new Error('备份文件名不合法')
  const src = join(dataDir(), name)
  if (!existsSync(src)) throw new Error('找不到这份备份文件')

  const dir = dataDir()
  const dbFile = join(dir, 'novel.db')
  getDb()
  const safeguard = basename(snapshotDb('pre-restore'))
  closeDb()

  const stash = join(dir, `restore-stash-${Date.now()}`)
  mkdirSync(stash)
  for (const f of DB_FILES) {
    const p = join(dir, f)
    if (existsSync(p)) renameSync(p, join(stash, f))
  }
  try {
    if (name.endsWith('.gz')) writeFileSync(dbFile, gunzipSync(readFileSync(src)))
    else copyFileSync(src, dbFile)
    const books = (getDb().prepare('SELECT count(*) AS n FROM books').get() as { n: number }).n
    rmSync(stash, { recursive: true, force: true })
    console.log(`[backup] 已恢复到 ${name}（恢复前的数据留在 ${safeguard}）`)
    return { books, safeguard }
  } catch (e) {
    closeDb()
    for (const f of DB_FILES) rmSync(join(dir, f), { force: true })
    for (const f of DB_FILES) {
      const p = join(stash, f)
      if (existsSync(p)) renameSync(p, join(dir, f))
    }
    rmSync(stash, { recursive: true, force: true })
    getDb()
    throw new Error(
      `这份备份用不了（${e instanceof Error ? e.message : String(e)}），已换回原来的数据`
    )
  }
}
