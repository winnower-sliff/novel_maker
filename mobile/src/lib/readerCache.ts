import type { ChapterBrief } from '@shared/types'
import { useSettingsStore } from '@mobile/lib/settingsStore'

/**
 * 阅读离线缓存：IndexedDB（整本正文缓存体量在 MB 级，localStorage 会爆配额）。
 * - chapters store：已预取的章节正文（keyPath id，projectId 二级索引支持按书统计/清除）
 * - briefs store：每本书的目录快照（离线时章节列表仍可用）
 * - projects store：旧版项目列表快照（已由 qsnap 承载，仅保留清理路径）
 * - qsnap store：写作页列表数据快照（冷启动首帧不空屏，见 querySnapshot.ts）
 * 所有失败路径静默降级（返回空/null），绝不能影响在线主链路。
 */

const DB_NAME = 'nm-reader-cache'
const DB_VERSION = 3
const CH_STORE = 'chapters'
const BRIEF_STORE = 'briefs'
const PROJECT_STORE = 'projects'
const QSNAP_STORE = 'qsnap'

export interface CachedChapter {
  id: string
  projectId: string
  volume: number
  chapterNo: number
  title: string
  content: string
  wordCount: number
  cachedAt: number
}

export interface CachedBriefs {
  projectId: string
  title: string
  briefs: ChapterBrief[]
  cachedAt: number
}

export interface CachedBookEntry {
  projectId: string
  title: string
  /** 目录快照里的已写章数（缓存目标总数） */
  total: number
  /** 实际已缓存正文章数 */
  cached: number
  cachedAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(CH_STORE)) {
          const store = db.createObjectStore(CH_STORE, { keyPath: 'id' })
          store.createIndex('projectId', 'projectId', { unique: false })
        }
        if (!db.objectStoreNames.contains(BRIEF_STORE)) {
          db.createObjectStore(BRIEF_STORE, { keyPath: 'projectId' })
        }
        if (!db.objectStoreNames.contains(PROJECT_STORE)) {
          db.createObjectStore(PROJECT_STORE, { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains(QSNAP_STORE)) {
          db.createObjectStore(QSNAP_STORE, { keyPath: 'key' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const req = run(db.transaction(store, mode).objectStore(store))
          req.onsuccess = () => resolve(req.result as T)
          req.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      })
  )
}

export async function getCachedChapter(id: string): Promise<CachedChapter | null> {
  return tx<CachedChapter>(CH_STORE, 'readonly', (s) => s.get(id) as IDBRequest<CachedChapter>)
}

export async function putChapters(items: CachedChapter[]): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction(CH_STORE, 'readwrite')
      const store = t.objectStore(CH_STORE)
      for (const item of items) store.put(item)
      t.oncomplete = () => resolve()
      t.onerror = () => resolve()
      t.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

export async function getCachedBriefs(projectId: string): Promise<CachedBriefs | null> {
  return tx<CachedBriefs>(BRIEF_STORE, 'readonly', (s) => s.get(projectId) as IDBRequest<CachedBriefs>)
}

export async function putBriefs(entry: CachedBriefs): Promise<void> {
  await tx<IDBValidKey>(BRIEF_STORE, 'readwrite', (s) => s.put(entry))
}

// —— 项目列表：改由 qsnap 快照承载（querySnapshot.withSnapshot），此 store 仅保留清理路径 ——

async function cachedCount(projectId: string): Promise<number> {
  const db = await openDb()
  if (!db) return 0
  return new Promise((resolve) => {
    try {
      const index = db.transaction(CH_STORE, 'readonly').objectStore(CH_STORE).index('projectId')
      const req = index.count(IDBKeyRange.only(projectId))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(0)
    } catch {
      resolve(0)
    }
  })
}

async function cachedIds(projectId: string): Promise<Set<string>> {
  const db = await openDb()
  if (!db) return new Set()
  return new Promise((resolve) => {
    try {
      const index = db.transaction(CH_STORE, 'readonly').objectStore(CH_STORE).index('projectId')
      const req = index.getAllKeys(IDBKeyRange.only(projectId))
      req.onsuccess = () => resolve(new Set(req.result as string[]))
      req.onerror = () => resolve(new Set())
    } catch {
      resolve(new Set())
    }
  })
}

export async function listCachedBooks(): Promise<CachedBookEntry[]> {
  const rows = await tx<CachedBriefs[]>(BRIEF_STORE, 'readonly', (s) => s.getAll() as IDBRequest<CachedBriefs[]>)
  if (!rows || rows.length === 0) return []
  return Promise.all(
    rows.map(async (r) => ({
      projectId: r.projectId,
      title: r.title,
      total: r.briefs.filter((b) => b.hasDraft).length,
      cached: await cachedCount(r.projectId),
      cachedAt: r.cachedAt
    }))
  )
}

function clearBookProgress(projectId: string): void {
  useSettingsStore.getState().clearReadPos(projectId)
}

export async function clearBook(projectId: string): Promise<void> {
  clearBookProgress(projectId)
  await clearProjectSnapshots(projectId)
  const db = await openDb()
  if (!db) return
  // IDBIndex 无 delete：先取该书全部主键，再逐键删正文
  const keys = await cachedIds(projectId)
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction([CH_STORE, BRIEF_STORE], 'readwrite')
      const chStore = t.objectStore(CH_STORE)
      for (const key of keys) chStore.delete(key)
      t.objectStore(BRIEF_STORE).delete(projectId)
      t.oncomplete = () => resolve()
      t.onerror = () => resolve()
      t.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

// —— 写作页 query 快照：冷启动首帧不空屏（每次进页仍从服务器刷新） ——

export interface QuerySnapshot {
  /** JSON.stringify(queryKey) */
  key: string
  data: unknown
  savedAt: number
}

export async function saveSnapshot(key: string, data: unknown): Promise<void> {
  await tx<IDBValidKey>(QSNAP_STORE, 'readwrite', (s) =>
    s.put({ key, data, savedAt: Date.now() })
  )
}

export async function getSnapshot(key: string): Promise<QuerySnapshot | null> {
  return tx<QuerySnapshot>(QSNAP_STORE, 'readonly', (s) => s.get(key) as IDBRequest<QuerySnapshot>)
}

export async function getAllSnapshots(): Promise<QuerySnapshot[]> {
  const rows = await tx<QuerySnapshot[]>(
    QSNAP_STORE,
    'readonly',
    (s) => s.getAll() as IDBRequest<QuerySnapshot[]>
  )
  return rows ?? []
}

/** 删某本书相关的快照（query key 数组里含该 projectId 的条目） */
async function clearProjectSnapshots(projectId: string): Promise<void> {
  const rows = await getAllSnapshots()
  const hit = rows.filter((r) => {
    try {
      const arr = JSON.parse(r.key) as unknown
      return Array.isArray(arr) && arr.includes(projectId)
    } catch {
      return false
    }
  })
  if (hit.length === 0) return
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction(QSNAP_STORE, 'readwrite')
      for (const r of hit) t.objectStore(QSNAP_STORE).delete(r.key)
      t.oncomplete = () => resolve()
      t.onerror = () => resolve()
      t.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

export async function clearAllBooks(): Promise<void> {
  useSettingsStore.getState().clearReadPos()
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction([CH_STORE, BRIEF_STORE, PROJECT_STORE, QSNAP_STORE], 'readwrite')
      t.objectStore(CH_STORE).clear()
      t.objectStore(BRIEF_STORE).clear()
      t.objectStore(PROJECT_STORE).clear()
      t.objectStore(QSNAP_STORE).clear()
      t.oncomplete = () => resolve()
      t.onerror = () => resolve()
      t.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

// —— 整本预取器：进入阅读页触发，增量（跳过已缓存）、3 路并发、失败静默续传 ——

export interface PrefetchState {
  done: number
  total: number
}

const prefetching = new Map<string, PrefetchState>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const fn of listeners) fn()
}

export function subscribePrefetch(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getPrefetch(projectId: string): PrefetchState | undefined {
  return prefetching.get(projectId)
}

/** 并发上限：小队列逐章拉，避免移动网络下瞬间打满服务器 */
const CONCURRENCY = 3

export async function prefetchBook(projectId: string, briefs: ChapterBrief[]): Promise<void> {
  if (prefetching.has(projectId)) return
  const todo = briefs.filter((b) => b.hasDraft)
  if (todo.length === 0) return
  const cached = await cachedIds(projectId)
  const queue = todo.filter((b) => !cached.has(b.id))
  if (queue.length === 0) return

  prefetching.set(projectId, { done: 0, total: queue.length })
  notify()
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const b = queue[cursor]
      cursor += 1
      try {
        const ch = await window.api.novel.chapter(b.id)
        if (!ch) throw new Error('chapter not written')
        await putChapters([
          {
            id: b.id,
            projectId,
            volume: b.volume,
            chapterNo: b.chapterNo,
            title: b.title,
            content: ch.content,
            wordCount: ch.wordCount,
            cachedAt: Date.now()
          }
        ])
      } catch {
        // 静默：单章失败不中断预取，下次进入续传
      }
      const p = prefetching.get(projectId)
      if (p) {
        p.done += 1
        notify()
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()))
  prefetching.delete(projectId)
  notify()
}
