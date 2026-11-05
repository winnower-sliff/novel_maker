import { create } from 'zustand'

/**
 * 全局 UI 态（产品极简：书架/设置两 tab + 书内全屏工作区 + 开书引导全屏）。
 * 数据层走 TanStack Query；这里只有导航与视图态。
 */
type Tab = 'shelf' | 'settings'
type BookSub = 'write' | 'read' | 'cards' | 'lines'

interface UiState {
  tab: Tab
  /** 书内工作区（全屏覆盖，含底部子导航） */
  openBookId: string | null
  bookSub: BookSub
  /** 开书引导中的书（全屏向导） */
  onboardBookId: string | null
  setTab: (tab: Tab) => void
  openBook: (bookId: string) => void
  closeBook: () => void
  setBookSub: (sub: BookSub) => void
  startOnboard: (bookId: string) => void
  finishOnboard: () => void
}

export const useUiStore = create<UiState>((set) => ({
  tab: 'shelf',
  openBookId: null,
  bookSub: 'write',
  onboardBookId: null,
  setTab: (tab) => set({ tab }),
  openBook: (bookId) => set({ openBookId: bookId, bookSub: 'write' }),
  closeBook: () => set({ openBookId: null }),
  setBookSub: (bookSub) => set({ bookSub }),
  startOnboard: (bookId) => set({ onboardBookId: bookId, openBookId: null }),
  finishOnboard: () => set({ onboardBookId: null })
}))
