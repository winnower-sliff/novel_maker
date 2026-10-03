import { create } from 'zustand'

/** 写作页章节列表的分段展开态：默认全折叠，展开的段记在 openSegs（会话内记忆，杀进程重置）。 */
interface WriteListState {
  openSegs: Set<string>
  toggleSeg: (key: string) => void
}

export const useWriteListStore = create<WriteListState>((set) => ({
  openSegs: new Set<string>(),
  toggleSeg: (key) =>
    set((s) => {
      const next = new Set(s.openSegs)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { openSegs: next }
    })
}))
