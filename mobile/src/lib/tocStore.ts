import { create } from 'zustand'

const KEY = 'nm_toc_open'

function loadSet(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

function saveSet(s: Set<string>): void {
  localStorage.setItem(KEY, JSON.stringify([...s]))
}

/** 阅读目录页的分段展开态（localStorage 跨会话记忆；key 为 `${projectId}:${volume}:${segNo}`） */
interface TocState {
  openSegs: Set<string>
  toggleSeg: (key: string) => void
  /** 只展开不收起（定位上次阅读章节用，已展开则不触发更新） */
  expandSeg: (key: string) => void
}

export const useTocStore = create<TocState>((set) => ({
  openSegs: loadSet(),
  toggleSeg: (key) =>
    set((s) => {
      const next = new Set(s.openSegs)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveSet(next)
      return { openSegs: next }
    }),
  expandSeg: (key) =>
    set((s) => {
      if (s.openSegs.has(key)) return s
      const next = new Set(s.openSegs)
      next.add(key)
      saveSet(next)
      return { openSegs: next }
    })
}))
