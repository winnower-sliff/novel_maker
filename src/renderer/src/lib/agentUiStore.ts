import { create } from 'zustand'

export interface AgentNavBadge {
  tone: 'running' | 'confirming' | 'done' | 'error'
  pulse: boolean
}

interface AgentUiState {
  running: boolean
  confirming: boolean
  ended: { at: number; ok: boolean } | null
  seenAt: number
  set: (patch: Partial<Omit<AgentUiState, 'seenAt' | 'set' | 'markSeen'>>) => void
  markSeen: () => void
}

export const useAgentUiStore = create<AgentUiState>((set, get) => ({
  running: false,
  confirming: false,
  ended: null,
  seenAt: 0,
  set: (patch) => {
    const cur = get()
    const next = {
      running: patch.running ?? cur.running,
      confirming: patch.confirming ?? cur.confirming,
      ended: patch.ended !== undefined ? patch.ended : cur.ended
    }
    if (next.running && next.ended) next.ended = null
    set(next)
  },
  markSeen: () => {
    if (!get().ended) return
    set({ ended: null })
  }
}))

export function setAgentUi(patch: Partial<AgentUiState>): void {
  useAgentUiStore.getState().set(patch)
}

export function markAgentSeen(): void {
  useAgentUiStore.getState().markSeen()
}

const BADGES: Record<AgentNavBadge['tone'], AgentNavBadge> = {
  running: { tone: 'running', pulse: true },
  confirming: { tone: 'confirming', pulse: true },
  done: { tone: 'done', pulse: false },
  error: { tone: 'error', pulse: false }
}

export function useAgentNavBadge(): AgentNavBadge | null {
  return useAgentUiStore((s) => {
    if (s.confirming) return BADGES.confirming
    if (s.running) return BADGES.running
    if (s.ended) return s.ended.ok ? BADGES.done : BADGES.error
    return null
  })
}
