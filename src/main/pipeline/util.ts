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
  const start = text.indexOf('[')
  if (start < 0) return null
  const raw = sliceBetween(text, '[', ']')
  let best: unknown[] = []
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) best = parsed
    } catch {
      // 输出超长被 max_tokens 截断时 JSON 不完整，下面抢救已完整的对象
    }
  }
  // 分批拼接/截断场景：sliceBetween 可能漏掉后续未闭合数组，对全文做配平扫描兜底（取对象更多者）
  const scanned = salvageArrayObjects(text.slice(start))
  if (scanned.length > best.length) best = scanned
  return best.length > 0 ? best : null
}

// 从可能被截断的 JSON 数组文本中配平扫描出所有完整的顶层对象（坏对象跳过）
function salvageArrayObjects(raw: string): unknown[] {
  const out: unknown[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
    } else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(raw.slice(start, i + 1)) as unknown)
        } catch {
          // 单个对象坏则丢弃，不影响其余
        }
        start = -1
      }
      if (depth < 0) break
    }
  }
  return out
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
