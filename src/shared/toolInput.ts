/**
 * 工具参数 _raw 包裹恢复。
 * 流式 tool args JSON 解析失败（截断/非法）的旧实现在 catch 里回退成 { _raw: 原始片段 }，
 * 该形态随 assistant tool_use 回灌后会被模型模仿成 {"_raw": {...}}，造成连环失败（历史实锤）。
 * 现网已不再产生该形态，但历史会话与模型模仿仍可能传来，统一在此解包：
 * - 非 _raw 形态：原样返回（unwrapped=false）
 * - 单键 _raw 且值为对象或可解析的 JSON 对象字符串：解包（unwrapped=true）
 * - 单键 _raw 但解不开（截断残骸）：ok=false，调用方按参数解析失败处理，禁止回灌
 */
export type ToolInputRecovery =
  | { ok: true; input: Record<string, unknown>; unwrapped: boolean }
  | { ok: false }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseObjectString(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || !v.trim()) return null
  try {
    const parsed = JSON.parse(v) as unknown
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function recoverToolInput(
  input: Record<string, unknown> | null | undefined
): ToolInputRecovery {
  if (!isPlainObject(input)) return { ok: true, input: {}, unwrapped: false }
  let cur: Record<string, unknown> = input
  let unwrapped = false
  for (let depth = 0; depth < 4; depth++) {
    const keys = Object.keys(cur)
    if (keys.length !== 1 || keys[0] !== '_raw') return { ok: true, input: cur, unwrapped }
    const raw = cur._raw
    const next = isPlainObject(raw) ? raw : parseObjectString(raw)
    if (!next) return { ok: false }
    cur = next
    unwrapped = true
  }
  return { ok: false }
}
