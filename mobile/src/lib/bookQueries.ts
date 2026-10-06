import { queryOptions } from '@tanstack/react-query'
import { qk } from '@renderer/lib/queries'
import {
  fetchChapterIntoCache,
  getCachedBriefs,
  getCachedChapter,
  getSnapshot,
  putBriefs,
  saveSnapshot,
  type CachedChapter
} from './readerCache'
import { snapshotKey } from './querySnapshot'
import type { Chapter, ChapterBrief } from '@shared/types'

/**
 * 正文/目录查询的唯一工厂（阅读、写作、书架、Book 壳层共用）。
 * 同 key 必同 queryFn：此前四页各写各的（裸 api / 只写 IDB / 只写 qsnap），
 * TanStack 以首个挂载 observer 的 queryFn 为准，行为取决于进页顺序。
 *
 * - chapter：staleTime 2 分钟（阅读↔写作互通；完成事件与手动保存会主动失效），
 *   成功写 IndexedDB，断网回退缓存正文
 * - briefs：staleTime 60 秒，成功双写 IndexedDB+qsnap 快照，断网回退 IDB→qsnap
 * - 所有回退路径静默降级，绝不影响在线主链路
 */

/** 单章正文查询：离线回退时回调 onOffline(章 id, true)，新鲜数据为 (id, false) */
export function makeChapterQuery(
  projectId: string,
  brief: ChapterBrief,
  onOffline?: (id: string, offline: boolean) => void
) {
  return queryOptions({
    queryKey: qk.chapter(brief.id),
    queryFn: async (): Promise<Chapter | CachedChapter> => {
      try {
        const fresh = await fetchChapterIntoCache(projectId, brief)
        onOffline?.(brief.id, false)
        return fresh
      } catch (err) {
        const cached = await getCachedChapter(brief.id)
        if (cached) {
          onOffline?.(brief.id, true)
          return cached
        }
        throw err
      }
    },
    staleTime: 120_000
  })
}

/** 目录查询：title 用于 IndexedDB 目录快照（书架/阅读页离线展示书名） */
export function makeBriefsQuery(
  projectId: string,
  title: string,
  onOffline?: (offline: boolean) => void
) {
  return queryOptions({
    queryKey: qk.chapterBriefs(projectId),
    queryFn: async (): Promise<ChapterBrief[]> => {
      try {
        const fresh = await window.api.novel.chapterBriefs(projectId)
        onOffline?.(false)
        void saveSnapshot(snapshotKey(qk.chapterBriefs(projectId)), fresh)
        void putBriefs({ projectId, title, briefs: fresh, cachedAt: Date.now() })
        return fresh
      } catch (err) {
        const cached = await getCachedBriefs(projectId)
        if (cached) {
          onOffline?.(true)
          return cached.briefs
        }
        const snap = await getSnapshot(snapshotKey(qk.chapterBriefs(projectId)))
        if (snap) {
          onOffline?.(true)
          return snap.data as ChapterBrief[]
        }
        throw err
      }
    },
    staleTime: 60_000
  })
}
