import { getSkill } from '../skills'

export function skillBody(name: string): string {
  const f = getSkill(`${name}.md`)
  if (!f) return ''
  const match = /^---\r?\n[\s\S]*?\r?\n---/.exec(f.raw)
  return match ? f.raw.slice(match[0].length).trim() : f.raw
}

function sliceBetween(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

export function extractJsonArray(text: string): unknown[] | null {
  const raw = sliceBetween(text, '[', ']')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const raw = sliceBetween(text, '{', '}')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
