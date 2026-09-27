import * as store from './store'

/**
 * 零成本硬闸 lint（纯程序，不消耗 token）：
 * 接缝重复 / 穿帮词黑名单 / 元语言泄漏 / 字数达标 / 完全重复段落。
 */

export interface LintIssue {
  rule: string
  level: 'major' | 'minor'
  quote: string
  advice: string
}

export interface LintReport {
  issues: LintIssue[]
  score: number
  pass: boolean
  wordCount: number
  targetWords: number | null
}

/** 元语言与穿帮词（AI 味、出戏、prompt 泄漏） */
const BANNED_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /作为(?:一个)?(?:AI|人工智能|语言模型)/g, label: 'AI 自称' },
  { re: /(?:我无法|我不能|抱歉)[，,。]/g, label: '模型拒绝语' },
  { re: /以下是(?:为|根据)[^，。\n]{0,20}(?:续写|创作|正文|章节)/g, label: '输出引导语' },
  { re: /(?:总之|综上所述|总的来说)[，,]/g, label: '总结套话' },
  { re: /(?:值得注意|需要强调|不可否认|毋庸置疑)的(?:是)?[，,]/g, label: 'AI 高频套话' },
  { re: /(?:希望|相信).{0,12}(?:喜欢|满意|享受)/g, label: '结尾客套' },
  { re: /(?:本章|这一章)我们/g, label: '说书人口吻' },
  { re: /(?:大纲|梗概|伏笔操作|字数要求)[:：]/g, label: 'prompt 字段泄漏' },
  { re: /<!--[^>]*-->/g, label: 'HTML 注释残留' }
]

const MAX_QUOTE = 60

function clipQuote(s: string): string {
  return s.length > MAX_QUOTE ? `${s.slice(0, MAX_QUOTE)}…` : s
}

export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[^>]*-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

function seamOverlap(head: string, tail: string): number {
  const max = Math.min(300, head.length, tail.length)
  for (let n = max; n >= 20; n--) {
    if (head.slice(0, n) === tail.slice(-n)) return n
  }
  return 0
}

function findDuplicateParagraphs(text: string): string[][] {
  const seen = new Map<string, number>()
  const dups = new Map<string, string[]>()
  const paras = text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length >= 30)
  paras.forEach((p, i) => {
    const hit = seen.get(p)
    if (hit !== undefined) {
      dups.set(p, [...(dups.get(p) ?? [`${hit + 1} 段`]), `${i + 1} 段`])
    } else {
      seen.set(p, i)
    }
  })
  return [...dups.values()]
}

export function lintChapter(
  text: string,
  opts?: { prevTail?: string; targetWords?: number }
): LintReport {
  const issues: LintIssue[] = []
  const head = text.slice(0, 400)

  if (opts?.prevTail) {
    const overlap = seamOverlap(head, opts.prevTail.slice(-400))
    if (overlap >= 20) {
      issues.push({
        rule: '接缝重复',
        level: 'major',
        quote: clipQuote(head.slice(0, overlap)),
        advice: `本章开头与上一章结尾有 ${overlap} 字重叠，删掉重复部分`
      })
    }
  }

  for (const { re, label } of BANNED_PATTERNS) {
    const matches = [...text.matchAll(re)]
    if (matches.length > 0) {
      issues.push({
        rule: `${label}（${matches.length} 处）`,
        level: label === 'HTML 注释残留' ? 'minor' : 'major',
        quote: clipQuote(matches[0][0]),
        advice: label === 'HTML 注释残留' ? '定稿前剥离注释（保存时已自动处理）' : '删除或改写为自然叙述'
      })
    }
  }

  for (const group of findDuplicateParagraphs(text)) {
    issues.push({
      rule: '重复段落',
      level: 'major',
      quote: clipQuote(group[0]),
      advice: `同一段落在 ${group.join('、')} 重复出现`
    })
  }

  const wordCount = text.replace(/\s/g, '').length
  if (opts?.targetWords && opts.targetWords > 0) {
    const ratio = wordCount / opts.targetWords
    if (ratio < 0.6) {
      issues.push({
        rule: '字数不足',
        level: 'major',
        quote: '',
        advice: `目标 ${opts.targetWords} 字，实际 ${wordCount} 字（${Math.round(ratio * 100)}%）`
      })
    } else if (ratio > 1.5) {
      issues.push({
        rule: '字数超标',
        level: 'minor',
        quote: '',
        advice: `目标 ${opts.targetWords} 字，实际 ${wordCount} 字（${Math.round(ratio * 100)}%）`
      })
    }
  }

  const penalty = issues.reduce((a, i) => a + (i.level === 'major' ? 3 : 1), 0)
  const score = Math.max(0, 100 - penalty)
  return {
    issues,
    score,
    pass: issues.filter((i) => i.level === 'major').length === 0,
    wordCount,
    targetWords: opts?.targetWords ?? null
  }
}

/** 按大纲取上一章结尾并执行 lint（供 handler 调用） */
export function lintChapterReport(outlineId: string, text?: string): LintReport {
  const outline = store.getOutline(outlineId)
  if (!outline) return lintChapter('')
  const outlines = store.listOutlines(outline.projectId).sort((a, b) =>
    a.volume - b.volume || a.chapterNo - b.chapterNo
  )
  const idx = outlines.findIndex((o) => o.id === outlineId)
  let prevTail = ''
  for (let i = idx - 1; i >= 0 && !prevTail; i--) {
    const c = store.getChapterByOutline(outlines[i].id)
    if (c && c.content.trim()) prevTail = c.content.slice(-500)
  }
  const content = text ?? store.getChapterByOutline(outlineId)?.content ?? ''
  return lintChapter(content, { prevTail: prevTail || undefined })
}
