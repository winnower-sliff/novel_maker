import type { Protocol, ProviderId, ProviderPreset } from '@shared/providers'
import type { ProviderProfile, SettingsView } from '@shared/types'

/** 设置表单的共享切片：由 index 持有状态，各分区组件只读 + 回调写回 */
export interface SettingsForm {
  view: SettingsView | null
  provider: ProviderId
  /** 当前 provider 的草稿 profile */
  active: ProviderProfile
  preset: ProviderPreset
  protocol: Protocol
  keyConfigured: boolean
  patchDraft: (patch: Partial<ProviderProfile>) => void
}

/** 稳定序列化（对象键排序、忽略 undefined），用于草稿与已存值的深比较 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`
}
