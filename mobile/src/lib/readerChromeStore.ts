import { create } from 'zustand'

interface ReaderChromeState {
  /** 正文流（ReaderFlow）挂载中 */
  active: boolean
  /** true=壳层/上下栏展开，false=聚焦收起 */
  visible: boolean
  setActive: (v: boolean) => void
  setVisible: (v: boolean) => void
}

/** 阅读聚焦模式三层联动（Book 壳层书名行/tab 行 + Read 上下栏）共享的显隐态；易失 UI 态，不持久化 */
export const useReaderChromeStore = create<ReaderChromeState>((set) => ({
  active: false,
  visible: true,
  setActive: (v) => set({ active: v }),
  setVisible: (v) => set({ visible: v })
}))
