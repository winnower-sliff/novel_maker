/** 整卡 markdown（AI 生成预览/旧格式）→ 分节数组；与主进程 splitEntityCard 切分规则对齐：
 * `##` 人物头丢弃、`###`~`######` 起分节、「关联：」行→relation、`- 字段：内容` 列表项→分节 */
export interface ParsedSection {
  title: string
  content: string
}

export function parseCardSections(card: string): {
  sections: ParsedSection[]
  relation: string
} {
  const sections: ParsedSection[] = []
  let relation = ''
  let cur: ParsedSection | null = null
  for (const raw of card.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const h = line.match(/^#{3,6}\s+(.+)$/)
    if (h) {
      cur = { title: h[1].trim(), content: '' }
      sections.push(cur)
      continue
    }
    if (/^#{1,2}\s/.test(line)) {
      cur = null
      continue
    }
    const rel = line.match(/^关联[:：]\s*(.*)$/)
    if (rel) {
      relation = rel[1].trim()
      continue
    }
    const li = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/)
    if (li) {
      const m = /^([^：:]{1,24})[：:]\s*(.*)$/.exec(li[1].replace(/\*\*/g, '').trim())
      if (m && m[1].trim() !== '') {
        cur = { title: m[1].trim(), content: m[2] ?? '' }
        sections.push(cur)
        continue
      }
    }
    if (!line.trim() && !cur?.content) continue
    if (cur) {
      cur.content += (cur.content ? '\n' : '') + line
    } else {
      cur = { title: '', content: line }
      sections.push(cur)
    }
  }
  return {
    sections: sections.filter((s) => s.title.trim() || s.content.trim()),
    relation
  }
}
