import { create, type StoreApi, type UseBoundStore } from 'zustand'

/**
 * agent 聚合条状态（全局唯一）：从组件 useState 上提——
 * 切子页/回桌面再回来不丢进度；SSE 事件全局接线写入（App.tsx）。
 */

export interface ActItem {
  tool: string
  summary: string
  ok: boolean
  ts: number
}

interface TickerState {
  acts: ActItem[]
  progress: { phase: string; chars: number } | null
  /** chat 白话流式（正文） */
  chatText: string
  chatTotal: number
  /** 思考链流式（折叠区） */
  thinking: string
  thinkTotal: number
  pushAct: (act: ActItem) => void
  setProgress: (p: { phase: string; chars: number } | null) => void
  appendDelta: (chunk: string, total: number) => void
  setChatText: (t: string, total?: number) => void
  appendThink: (chunk: string, total: number) => void
  setThinking: (t: string, total?: number) => void
  reset: () => void
}

const byJob: Record<string, UseBoundStore<StoreApi<TickerState>>> = {}

/** 每个 job 一份独立 ticker 状态（hook 工厂，避免整表订阅引起全列表重渲染） */
export function tickerStore(jobId: string): UseBoundStore<StoreApi<TickerState>> {
  let s = byJob[jobId]
  if (!s) {
    s = create<TickerState>((set) => ({
      acts: [],
      progress: null,
      chatText: '',
      chatTotal: 0,
      thinking: '',
      thinkTotal: 0,
      pushAct: (act) =>
        set((st) => ({ acts: [...st.acts.slice(-49), act], progress: null })), // 新工具开跑，进度归零
      setProgress: (progress) => set({ progress }),
      appendDelta: (chunk, total) =>
        set((st) => ({ chatText: st.chatText + chunk, chatTotal: total })),
      setChatText: (t, total) => set({ chatText: t, chatTotal: total ?? t.length }),
      appendThink: (chunk, total) =>
        set((st) => ({ thinking: st.thinking + chunk, thinkTotal: total })),
      setThinking: (t, total) => set({ thinking: t, thinkTotal: total ?? t.length }),
      reset: () => set({ acts: [], progress: null, chatText: '', chatTotal: 0, thinking: '', thinkTotal: 0 })
    }))
    byJob[jobId] = s
  }
  return s
}
