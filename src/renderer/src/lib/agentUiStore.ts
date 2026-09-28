import { useSyncExternalStore } from 'react'

export interface AgentNavBadge {
  tone: 'running' | 'confirming' | 'done' | 'error'
  pulse: boolean
}

interface AgentUiState {
  running: boolean
  confirming: boolean
  ended: { at: number; ok: boolean } | null
}

let state: AgentUiState = { running: false, confirming: false, ended: null }
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setAgentUi(patch: Partial<AgentUiState>): void {
  state = {
    running: patch.running ?? state.running,
    confirming: patch.confirming ?? state.confirming,
    ended: patch.ended !== undefined ? patch.ended : state.ended
  }
  if (state.running && state.ended) state = { ...state, ended: null }
  emit()
}

export function markAgentSeen(): void {
  if (!state.ended) return
  state = { ...state, ended: null }
  emit()
}

const BADGES: Record<AgentNavBadge['tone'], AgentNavBadge> = {
  running: { tone: 'running', pulse: true },
  confirming: { tone: 'confirming', pulse: true },
  done: { tone: 'done', pulse: false },
  error: { tone: 'error', pulse: false }
}

function aggregateBadge(): AgentNavBadge | null {
  if (state.confirming) return BADGES.confirming
  if (state.running) return BADGES.running
  if (state.ended) return state.ended.ok ? BADGES.done : BADGES.error
  return null
}

export function useAgentNavBadge(): AgentNavBadge | null {
  return useSyncExternalStore(subscribe, aggregateBadge)
}
