import type { ChapterBrief, Project } from '@shared/types'
import { useSettingsStore } from '@mobile/lib/settingsStore'

/**
 * 阅读离线缓存：IndexedDB（整本正文缓存体量在 MB 级，localStorage 会爆配额）。
 * - chapters store：已预取的章节正文（keyPath id，projectId 二级索引支持按书统计/清除）
 * - briefs store：每本书的目录快照（离线时章节列表仍可用）
 * - projects store：项目列表快照（离线时书架仍可进书）
 * 所有失败路径静默降级（返回空/null），绝不能影响在线主链路。
 */

const DB_NAME = 'nm-reader-cache'
const DB_VERSION = 2
const CH_STORE = 'chapters'
const BRIEF_STORE = 'briefs'
const PROJECT_STORE = 'projects'

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

// —— 项目列表快照：离线时书架/进书仍可用 ——

export async function saveProjects(projects: Project[]): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction(PROJECT_STORE, 'readwrite')
      const store = t.objectStore(PROJECT_STORE)
      store.clear()
      for (const p of projects) store.put(p)
      t.oncomplete = () => resolve()
      t.onerror = () => resolve()
      t.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

export async function getCachedProjects(): Promise<Project[] | null> {
  const rows = await tx<Project[]>(
    PROJECT_STORE,
    'readonly',
    (s) => s.getAll() as IDBRequest<Project[]>
  )
  return rows && rows.length > 0 ? rows : null
}

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

export async function clearAllBooks(): Promise<void> {
  useSettingsStore.getState().clearReadPos()
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction([CH_STORE, BRIEF_STORE, PROJECT_STORE], 'readwrite')
      t.objectStore(CH_STORE).clear()
      t.objectStore(BRIEF_STORE).clear()
      t.objectStore(PROJECT_STORE).clear()
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
