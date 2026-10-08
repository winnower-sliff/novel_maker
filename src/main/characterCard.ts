/**
 * 人物卡分节切分/合并（单一事实源在 character_sections 表，card 列只是合并视图缓存）。
 * 合并视图格式与旧版整卡兼容：`## 名 #tags` 头 + `### 字段` 正文块 + 末尾 `关联：[[...]]`，
 * 使 graph/语义检索/上下文注入等读侧无需感知分节存储。
 */

export interface ParsedSection {
  /** 分节标题；空串表示无标题裸文本 */
  title: string
  content: string
}

export interface SplitCardResult {
  sections: ParsedSection[]
  /** `关联：[[目标|关系短语]]` 行的关系短语部分 */
  relation: string
}

/** 把旧式整卡 markdown 切分为 sections + relation（迁移与旧调用路径共用） */
export function splitCharacterCard(card: string): SplitCardResult {
  const sections: ParsedSection[] = []
  let relation = ''
  let cur: ParsedSection | null = null
  const bare: string[] = []
  for (const raw of card.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    // `## 人物名 #tags` 头：名字/标签已有独立列，丢弃
    if (/^##(?!#)\s*/.test(line)) {
      cur = null
      continue
    }
    // `###` 及更深标题 → 新节
    const h = /^#{3,6}\s+(.+)$/.exec(line)
    if (h) {
      cur = { title: h[1].trim(), content: '' }
      sections.push(cur)
      continue
    }
    // `关联：` 行 → relation
    if (/^关联[:：]\s*/.test(line)) {
      relation = line.replace(/^关联[:：]\s*/, '').trim()
      cur = null
      continue
    }
    // 列表项 `- 字段名：内容` → 新节（兼容 **加粗** 字段名与 * 列表符）
    const li = /^[-*]\s+(.+)$/.exec(line)
    if (li) {
      const m = /^([^:：]{1,24})[:：]\s*(.*)$/.exec(li[1].replace(/\*\*/g, '').trim())
      if (m && m[1].trim() !== '') {
        cur = { title: m[1].trim(), content: m[2].trim() }
        sections.push(cur)
        continue
      }
    }
    // 其余文本归入当前节或无标题裸文本
    if (cur) {
      cur.content = cur.content === '' ? line : `${cur.content}\n${line}`
    } else {
      bare.push(line)
    }
  }
  if (bare.length > 0) sections.unshift({ title: '', content: bare.join('\n') })
  return { sections, relation }
}

/** 合并视图：`## 名 #tags` + `### title` 正文块 + `关联：` 尾行 */
export function mergeCharacterCard(
  name: string,
  tags: string,
  sections: ParsedSection[],
  relation: string
): string {
  const parts: string[] = [`## ${name.trim()}${tags.trim() ? ` ${tags.trim()}` : ''}`]
  for (const s of sections) {
    parts.push('', s.title ? `### ${s.title}` : '')
    if (s.content.trim() !== '') parts.push(s.content.trim())
  }
  if (relation.trim() !== '') parts.push('', `关联：${relation.trim()}`)
  return parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
