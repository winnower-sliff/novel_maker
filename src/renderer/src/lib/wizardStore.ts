import { useSyncExternalStore } from 'react'

interface WizardState {
  open: boolean
  projectId: string | null
}

let state: WizardState = { open: false, projectId: null }
const listeners = new Set<() => void>()

function emit(next: WizardState): void {
  state = next
  listeners.forEach((l) => l())
}

export function openWizard(projectId: string): void {
  emit({ open: true, projectId })
}

export function closeWizard(): void {
  emit({ ...state, open: false })
}

export function useWizard(): WizardState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => state
  )
}
