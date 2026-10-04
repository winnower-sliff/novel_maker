import type { PremiseDraftCharacter, Project, WorldbuildEntry } from '@shared/types'

/**
 * 向导草稿存档（projects.wizard_plan JSON）。
 * saveProjectPlan 采用「读-合并-写」，多面板分别写各自字段互不覆盖（无需共享内存基线）。
 */
export interface WizardPlanSave {
  draftText: string
  wbBrief: string
  wbCats: string[]
  wbCount: number
  chars: PremiseDraftCharacter[]
  outlineIdea: string
  /** 通用规则：全书各卷大纲生成共用（区别于 volumePlans[volume].rules 的本卷规则） */
  outlineRules: string
  outlineCount: number
  volume: number
  startNo: number
  step: number
}

/** 每卷大纲生成参数记忆：key = 卷号字符串，重新生成时预填上次的设定 */
export interface VolumePlan {
  idea: string
  /** 起始章号已全自动推导（重写=该卷最小章号，新卷=全库最大章号+1），旧记忆仍保留此值 */
  startNo?: number
  count: number
  /** 节奏与硬性要求（原样透传给大纲生成，不经 AI 改写） */
  rules?: string
}

export type WizardPlanFull = WizardPlanSave & { volumePlans?: Record<string, VolumePlan> }

export const EMPTY_PLAN: WizardPlanFull = {
  draftText: '',
  wbBrief: '',
  wbCats: [],
  wbCount: 8,
  chars: [],
  outlineIdea: '',
  outlineRules: '',
  outlineCount: 20,
  volume: 1,
  startNo: 1,
  step: 0
}

export function parsePlan(raw: string | undefined | null): WizardPlanFull | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<WizardPlanFull> | null
    if (!v || typeof v !== 'object') return null
    return {
      ...EMPTY_PLAN,
      draftText: v.draftText ?? '',
      wbBrief: v.wbBrief ?? '',
      wbCats: Array.isArray(v.wbCats) ? v.wbCats : [],
      wbCount: typeof v.wbCount === 'number' ? v.wbCount : 8,
      chars: Array.isArray(v.chars) ? v.chars : [],
      outlineIdea: v.outlineIdea ?? '',
      outlineRules: v.outlineRules ?? '',
      outlineCount: typeof v.outlineCount === 'number' ? v.outlineCount : 20,
      volume: typeof v.volume === 'number' ? v.volume : 1,
      startNo: typeof v.startNo === 'number' ? v.startNo : 1,
      step: typeof v.step === 'number' ? Math.min(4, Math.max(0, v.step)) : 1,
      volumePlans:
        v.volumePlans && typeof v.volumePlans === 'object' && !Array.isArray(v.volumePlans)
          ? v.volumePlans
          : undefined
    }
  } catch {
    return null
  }
}

export async function loadProjectPlan(projectId: string): Promise<WizardPlanFull | null> {
  const projects = await window.api.novel.projects()
  const p = projects.find((x) => x.id === projectId)
  return parsePlan(p?.wizardPlan)
}

/** 读-合并-写：patch 只覆盖传入字段；clear=true 清空整个存档 */
export async function saveProjectPlan(
  projectId: string,
  patch: Partial<WizardPlanFull>,
  clear = false
): Promise<void> {
  if (clear) {
    await window.api.novel.projectUpdate(projectId, { wizardPlan: '' })
    return
  }
  const cur = (await loadProjectPlan(projectId)) ?? EMPTY_PLAN
  const next: WizardPlanFull = {
    ...cur,
    ...patch,
    volumePlans: patch.volumePlans ?? cur.volumePlans
  }
  await window.api.novel.projectUpdate(projectId, { wizardPlan: JSON.stringify(next) })
}

/** 存档损坏/换端时的库数据回填：以项目库实际内容为准，已生成进度不丢 */
export function backfillPlan(
  plan: WizardPlanFull | null,
  wb: WorldbuildEntry[],
  chars: { name: string; role: string }[]
): WizardPlanFull {
  const merged: WizardPlanFull = plan ?? { ...EMPTY_PLAN }
  if (merged.wbCats.length === 0 && wb.length > 0)
    merged.wbCats = Array.from(new Set(wb.map((w) => w.category)))
  if (!merged.chars.some((c) => c.name.trim()) && chars.length > 0)
    merged.chars = chars.map((c) => ({ name: c.name, brief: c.role }))
  return merged
}

/** 项目加载便捷函数：project + plan 一次拿齐 */
export async function loadProjectWithPlan(
  projectId: string
): Promise<{ project: Project | null; plan: WizardPlanFull | null }> {
  const projects = await window.api.novel.projects()
  const project = projects.find((x) => x.id === projectId) ?? null
  return { project, plan: parsePlan(project?.wizardPlan) }
}
