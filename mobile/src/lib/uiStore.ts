import { create } from 'zustand'

/**
 * 全局 UI 态（产品极简：写书/范文/设置三个底部 tab + 书内全屏工作区 + 开书引导全屏）。
 * 数据层走 TanStack Query；这里只有导航与视图态。
 * tab 取值沿用旧名（shelf 即界面上的「写书」页）。
 */
type Tab = 'shelf' | 'samples' | 'settings'
type BookSub = 'write' | 'read' | 'cards' | 'lines'

interface UiState {
  tab: Tab
  /** 书内工作区（全屏覆盖，含底部子导航） */
  openBookId: string | null
  bookSub: BookSub
  /** 开书引导中的书（全屏向导） */
  onboardBookId: string | null
  /** 阅读页当前是否夜间主题（底栏跟随深色；仅阅读子页生效，离开自动复位） */
  readerDark: boolean
  setTab: (tab: Tab) => void
  openBook: (bookId: string) => void
  closeBook: () => void
  setBookSub: (sub: BookSub) => void
  startOnboard: (bookId: string) => void
  finishOnboard: () => void
  setReaderDark: (dark: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  tab: 'shelf',
  openBookId: null,
  bookSub: 'write',
  onboardBookId: null,
  readerDark: false,
  setTab: (tab) => set({ tab }),
  openBook: (bookId) => {
    try {
      localStorage.setItem('nm-last-opened', bookId)
    } catch {
      // 无痕模式等场景忽略
    }
    set({ openBookId: bookId, bookSub: 'write' })
  },
  closeBook: () => set({ openBookId: null }),
  setBookSub: (bookSub) => set({ bookSub }),
  startOnboard: (bookId) => set({ onboardBookId: bookId, openBookId: null }),
  finishOnboard: () => set({ onboardBookId: null }),
  setReaderDark: (readerDark) => set({ readerDark })
}))
