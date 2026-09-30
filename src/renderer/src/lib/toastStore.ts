import { create } from 'zustand'

export type ToastTone = 'success' | 'error'

export interface ToastItem {
  id: number
  tone: ToastTone
  text: string
}

interface ToastState {
  toasts: ToastItem[]
  push: (tone: ToastTone, text: string) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (tone, text) => {
    const item: ToastItem = { id: nextId++, tone, text }
    set((s) => ({ toasts: [...s.toasts, item] }))
    setTimeout(() => useToastStore.getState().dismiss(item.id), 4000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

export function pushToast(tone: ToastTone, text: string): void {
  useToastStore.getState().push(tone, text)
}

export function dismissToast(id: number): void {
  useToastStore.getState().dismiss(id)
}

export function useToasts(): ToastItem[] {
  return useToastStore((s) => s.toasts)
}
