export function splitTags(raw: string | undefined | null): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[,，、#]+/)) {
    const t = part.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

export function joinTags(tags: string[]): string {
  return splitTags(tags.join(',')).join(',')
}

const TRAILING_TAGS_RE = /\s+((?:#[^\s#]+)(?:\s*#[^\s#]+)*)\s*$/

export function splitHeadingHashtags(rawTitle: string): { title: string; tags: string[] } {
  const m = TRAILING_TAGS_RE.exec(rawTitle)
  if (!m) return { title: rawTitle.trim(), tags: [] }
  return {
    title: rawTitle.slice(0, m.index).trim(),
    tags: splitTags(m[1])
  }
}
