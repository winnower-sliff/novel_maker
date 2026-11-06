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
  chatText: string
  chatTotal: number
  pushAct: (act: ActItem) => void
  setProgress: (p: { phase: string; chars: number } | null) => void
  appendDelta: (text: string, total: number) => void
  setChatText: (text: string) => void
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
      pushAct: (act) =>
        set((st) => ({ acts: [...st.acts.slice(-49), act], progress: null })), // 新工具开跑，进度归零
      setProgress: (progress) => set({ progress }),
      // text=增量 chunk，total=服务端累计长度；失配时调用方（App 兜底）拉 payload.answer 纠正
      appendDelta: (text, total) =>
        set((st) => ({ chatText: st.chatText + text, chatTotal: total })),
      setChatText: (chatText) => set({ chatText, chatTotal: chatText.length }),
      reset: () => set({ acts: [], progress: null, chatText: '', chatTotal: 0 })
    }))
    byJob[jobId] = s
  }
  return s
}
