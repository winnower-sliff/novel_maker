import { create } from 'zustand'

const FONT_KEY = 'nm-read-font'
const MIN = 12
const MAX = 28
const DEFAULT = 17

function loadFont(): number {
  try {
    const v = Number.parseInt(localStorage.getItem(FONT_KEY) ?? '', 10)
    return Number.isFinite(v) && v >= MIN && v <= MAX ? v : DEFAULT
  } catch {
    return DEFAULT
  }
}

interface ReaderState {
  /** 阅读正文字号（px），设置页与阅读页共用，localStorage 持久化 */
  font: number
  setFont: (v: number) => void
  /** 最近一次目录数据是否来自离线缓存 */
  offlineBriefs: boolean
  /** 最近一次章节正文是否来自离线缓存 */
  offlineChapter: boolean
  setOffline: (kind: 'briefs' | 'chapter', v: boolean) => void
}

/** 阅读设置共享态：key 沿用旧 nm-read-font，历史字号无缝迁移 */
export const useReaderStore = create<ReaderState>((set) => ({
  font: loadFont(),
  setFont: (v) => {
    const font = Math.min(MAX, Math.max(MIN, v))
    try {
      localStorage.setItem(FONT_KEY, String(font))
    } catch {
      // 持久化失败不阻断本次调整
    }
    set({ font })
  },
  offlineBriefs: false,
  offlineChapter: false,
  setOffline: (kind, v) => set(kind === 'briefs' ? { offlineBriefs: v } : { offlineChapter: v })
}))
