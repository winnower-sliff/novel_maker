export interface WikiSegment {
  type: 'text' | 'link'
  value: string
}

const WIKI_LINK_RE = /\[\[([^[\]]+?)\]\]/g

export function parseWikiLinks(text: string): WikiSegment[] {
  const segments: WikiSegment[] = []
  let last = 0
  for (const m of text.matchAll(WIKI_LINK_RE)) {
    const idx = m.index ?? 0
    if (idx > last) segments.push({ type: 'text', value: text.slice(last, idx) })
    const name = m[1].trim()
    if (name) segments.push({ type: 'link', value: name })
    last = idx + m[0].length
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) })
  return segments
}

export function extractLinkNames(text: string): string[] {
  return [...new Set([...text.matchAll(WIKI_LINK_RE)].map((m) => m[1].trim()).filter(Boolean))]
}
