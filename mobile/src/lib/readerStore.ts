import { create } from 'zustand'

interface ReaderState {
  /** 最近一次目录数据是否来自离线缓存 */
  offlineBriefs: boolean
  /** 最近一次章节正文是否来自离线缓存 */
  offlineChapter: boolean
  setOffline: (kind: 'briefs' | 'chapter', v: boolean) => void
}

/** 阅读离线状态标记（易失 UI 态，不持久化；字号等设置在 settingsStore） */
export const useReaderStore = create<ReaderState>((set) => ({
  offlineBriefs: false,
  offlineChapter: false,
  setOffline: (kind, v) => set(kind === 'briefs' ? { offlineBriefs: v } : { offlineChapter: v })
}))
