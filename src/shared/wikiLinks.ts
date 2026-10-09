/** 从文本提取 [[目标|别名]] / [[目标]] 链接目标（去重保序） */
export function parseWikiLinks(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(/\[\[([^\][|]+)(?:\|[^\][]*)?\]\]/g)) {
    const target = m[1].trim()
    if (target && !seen.has(target)) {
      seen.add(target)
      out.push(target)
    }
  }
  return out
}
