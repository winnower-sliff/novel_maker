import { create } from 'zustand'

interface WizardState {
  open: boolean
  projectId: string | null
  /** openWizard 指定的目标步（null=按草稿/现有内容自动定位），仅在打开时作 step 初值 */
  initialStep: number | null
  /** 当前步（0..4），真源；步骤推进/回退统一走 setStep */
  step: number
  setStep: (s: number) => void
  /** projectId=null 表示创建模式：向导 step0 为新建表单，创建成功后向导内部绑定新 id */
  openWizard: (projectId: string | null, step?: number) => void
  closeWizard: () => void
}

export const useWizardStore = create<WizardState>((set) => ({
  open: false,
  projectId: null,
  initialStep: null,
  step: 0,
  setStep: (s) => set({ step: s }),
  openWizard: (projectId, step) =>
    set({ open: true, projectId, initialStep: step ?? null, step: step ?? 0 }),
  closeWizard: () => set({ open: false })
}))

export function openWizard(projectId: string | null, step?: number): void {
  useWizardStore.getState().openWizard(projectId, step)
}

export function closeWizard(): void {
  useWizardStore.getState().closeWizard()
}

export function useWizard(): WizardState {
  return useWizardStore()
}
