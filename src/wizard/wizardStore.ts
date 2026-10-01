import { create } from 'zustand'

interface WizardState {
  open: boolean
  projectId: string | null
  step: number | null
  openWizard: (projectId: string, step?: number) => void
  closeWizard: () => void
}

export const useWizardStore = create<WizardState>((set) => ({
  open: false,
  projectId: null,
  step: null,
  openWizard: (projectId, step) => set({ open: true, projectId, step: step ?? null }),
  closeWizard: () => set({ open: false })
}))

export function openWizard(projectId: string, step?: number): void {
  useWizardStore.getState().openWizard(projectId, step)
}

export function closeWizard(): void {
  useWizardStore.getState().closeWizard()
}

export function useWizard(): WizardState {
  return useWizardStore()
}
