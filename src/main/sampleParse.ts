import { randomUUID } from 'node:crypto'

/** 范文结构节：章或资料段 */
export interface SampleSection {
  id: string
  sampleId: string
  kind: 'chapter' | 'section'
  label: string
  start: number
  end: number
  chars: number
}

/** 章标题行：第 12 章 / 第十二章 回门 / 第3回 / 序章 / 楔子 / 尾声 / 番外N */
const CHAPTER_RE =
  /^[ \t]*(第\s*[0-9０-９一二三四五六七八九十百千零两]+\s*[章回节卷][^\n]{0,40}|[序序章楔子]|序章|楔子|尾声|终章|番外[^\n]{0,20})$/
/** 大资料段标题：════ 分隔线标题 ════ / 第X部分 · … / 【结构导读】这类行 */
const SECTION_RE =
  /^[ \t]*(={3,}|═{3,}|[-—]{4,})[^\n]{0,60}(\1)[ \t]*$|^[ \t]*第[一二三四五六七八九十]+部分[^\n]{0,40}$/

/**
 * 把范文全文切成节序列（章为主，资料大段为辅）。
 * 章匹配标题独立行；资料段匹配装饰线/「第X部分」标题行。
 * 返回按 start 升序、互不重叠的节列表；两节之间的「前言/杂项」不成品化（仍可按百分比翻阅）。
 */
export function parseSampleSections(sampleId: string, content: string): SampleSection[] {
  const lines = content.split('\n')
  const marks: { kind: 'chapter' | 'section'; label: string; start: number }[] = []
  let offset = 0
  for (const line of lines) {
    const lineStart = offset
    offset += line.length + 1
    const trimmed = line.trim()
    if (!trimmed) continue
    const chapterMatch = trimmed.match(CHAPTER_RE)
    if (chapterMatch) {
      marks.push({ kind: 'chapter', label: trimmed.slice(0, 60), start: lineStart })
      continue
    }
    if (SECTION_RE.test(trimmed)) {
      marks.push({
        kind: 'section',
        label: trimmed.replace(/[═=]/g, '').trim().slice(0, 60) || trimmed.slice(0, 40),
        start: lineStart
      })
    }
  }
  const out: SampleSection[] = []
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]
    if (!m) continue
    const end = i + 1 < marks.length ? (marks[i + 1]?.start ?? content.length) : content.length
    if (end - m.start < 50) continue // 太薄的标记不算一节（目录页章名等）
    out.push({
      id: randomUUID(),
      sampleId,
      kind: m.kind,
      label: m.label,
      start: m.start,
      end,
      chars: end - m.start
    })
  }
  return out
}

/** 章号数字 → 中文（解析「第N章」label 用统一比较） */
export function chapterNoOfLabel(label: string): number | null {
  const m = label.match(/第\s*([0-9０-９]+|[一二三四五六七八九十百千零两]+)\s*[章回节卷]/)
  if (!m?.[1]) return null
  const raw = m[1]
  if (/^[0-9]+$/.test(raw)) return Number(raw)
  const digits = '零一二三四五六七八九'
  let n = 0
  for (const ch of raw) {
    const d = digits.indexOf(ch)
    if (d >= 0) n = n * 10 + d
    else if (ch === '十') n = (n || 1) * 10
    else if (ch === '百') n = (n || 1) * 100
    else if (ch === '千') n = (n || 1) * 1000
  }
  return n || null
}
