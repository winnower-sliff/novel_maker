import type { Purpose } from '@shared/types'

export const PURPOSE_LABELS: Record<string, string> = {
  playground: '试写',
  outline: '大纲',
  chapter: '正文',
  summary: '摘要',
  polish: '润色',
  check: '检查',
  review: '评审',
  expand: '扩写',
  agent: '智能体'
}

export function purposeLabel(p: Purpose | string): string {
  return PURPOSE_LABELS[p] ?? p
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function fmtDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
