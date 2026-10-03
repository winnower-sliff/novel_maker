/** 章节正文存储格式：首行 `## 第N章 标题`（或同级 md 标题），其后为正文。
 *  编辑器/阅读器只展示正文，标题经大纲（outlines.title）单独呈现。 */

const HEADING_RE = /^#{1,3}\s[^\n]*\n?/

/** 拆出首行标题与其后正文；无标题行时 heading 为空串、body 即原文（不丢字） */
export function splitChapterHeading(content: string): { heading: string; body: string } {
  const m = content.match(HEADING_RE)
  if (!m) return { heading: '', body: content }
  return {
    heading: m[0].replace(/\n$/, ''),
    body: content.slice(m[0].length).replace(/^\n+/, '')
  }
}

/** 标题与正文重组落库；heading 为空（原文无标题）时原样返回正文 */
export function joinChapterContent(heading: string, body: string): string {
  if (!heading) return body
  return body ? `${heading}\n\n${body}` : heading
}
