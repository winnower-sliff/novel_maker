import { useSyncExternalStore } from 'react'

export type ToastTone = 'success' | 'error'

export interface ToastItem {
  id: number
  tone: ToastTone
  text: string
}

let toasts: ToastItem[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((l) => l())
}

export function pushToast(tone: ToastTone, text: string): void {
  const item: ToastItem = { id: nextId++, tone, text }
  toasts = [...toasts, item]
  emit()
  setTimeout(() => dismissToast(item.id), 4000)
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(subscribe, () => toasts)
}
