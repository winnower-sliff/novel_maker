import { type QueryClient, type QueryKey } from '@tanstack/react-query'
import { getAllSnapshots, getSnapshot, saveSnapshot } from './readerCache'

/**
 * 写作页 query 快照：列表类数据持久化到 IndexedDB，冷启动 hydrate 出首帧（不从空开始）。
 * - 每次进页仍从服务器刷新：hydrate 后立即标 invalid，挂载必 refetch
 * - refetch 失败回退快照（断网显示旧数据，不白屏）
 * - 单章正文不缓存（有脏状态，旧稿易误导）
 * - 所有失败路径静默降级，绝不能影响在线主链路
 */

export function snapshotKey(key: QueryKey): string {
  return JSON.stringify(key)
}

/** queryFn 包装：成功双写快照；失败回退快照，无快照抛原错误 */
export function withSnapshot<T>(key: QueryKey, fetcher: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      const fresh = await fetcher()
      void saveSnapshot(snapshotKey(key), fresh)
      return fresh
    } catch (err) {
      const snap = await getSnapshot(snapshotKey(key))
      if (snap) return snap.data as T
      throw err
    }
  }
}

/** 启动时把全部快照灌进 query cache：先 set 再标 invalid，保证挂载即 refetch */
export async function hydrateSnapshots(queryClient: QueryClient): Promise<void> {
  const rows = await getAllSnapshots()
  for (const row of rows) {
    try {
      const key = JSON.parse(row.key) as QueryKey
      queryClient.setQueryData(key, row.data)
      void queryClient.invalidateQueries({ queryKey: key })
    } catch {
      // 静默：坏快照跳过
    }
  }
}
