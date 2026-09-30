import type { BuiltContext, ChatParams, ReviewResult, ReviewScore } from '../../shared/types'
import { buildChapterContext } from '../context'
import * as store from '../store'
import { extractJsonArray, extractJsonObject, skillBody } from './util'

export async function buildChapterRequest(
  projectId: string,
  outlineId: string,
  wordTarget?: number
): Promise<{ params: ChatParams; ctx: BuiltContext }> {
  const ctx = await buildChapterContext(projectId, outlineId, wordTarget)
  const system = [skillBody('chapter-writer'), ctx.system].filter(Boolean).join('\n\n')
  return {
    params: {
      model: '',
      system,
      messages: [{ role: 'user', content: ctx.user }],
      maxTokens: 16384,
      temperature: 0.8,
      purpose: 'chapter'
    },
    ctx
  }
}

export function buildSummaryRequest(projectId: string, outlineId: string): ChatParams {
  const outlines = store.listOutlines(projectId)
  const o = outlines.find((x) => x.id === outlineId)
  const chapter = o ? store.getChapterByOutline(o.id) : null
  if (!o || !chapter) throw new Error('该章节还没有正文，无法生成摘要')
  const chars = store
    .listCharacters(projectId)
    .map((c) => c.name)
    .join('、')
  const system = [skillBody('summarizer'), chars && `本书人物名单：${chars}`]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: '',
    system,
    messages: [
      { role: 'user', content: `第${o.chapterNo}章《${o.title}》正文：\n\n${chapter.content}` }
    ],
    maxTokens: 2048,
    temperature: 0.3,
    purpose: 'summary'
  }
}

export function buildPolishRequest(
  projectId: string,
  outlineId: string,
  focus?: string
): ChatParams {
  const project = store.listProjects().find((x) => x.id === projectId)
  const outline = store.getOutline(outlineId)
  const chapter = outline ? store.getChapterByOutline(outlineId) : null
  if (!outline || !chapter?.content.trim()) throw new Error('该章节还没有正文，无法润色')
  const system = [
    skillBody('style-polisher'),
    project?.styleGuide && `【作品风格】\n${project.styleGuide}`,
    focus && `【本次定向修复重点（优先处理，其余保持原意）】\n${focus}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: '',
    system,
    messages: [
      {
        role: 'user',
        content: `第${outline.chapterNo}章《${outline.title}》正文：\n\n${chapter.content}`
      }
    ],
    maxTokens: 16384,
    temperature: 0.5,
    purpose: 'polish'
  }
}

export async function buildCheckRequest(projectId: string, outlineId: string): Promise<ChatParams> {
  const outline = store.getOutline(outlineId)
  const chapter = outline ? store.getChapterByOutline(outlineId) : null
  if (!outline || !chapter?.content.trim()) throw new Error('该章节还没有正文，无法检查')
  const ctx = await buildChapterContext(projectId, outlineId)
  const system = [skillBody('continuity-checker'), ctx.system].filter(Boolean).join('\n\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: `请检查以下章节正文：\n\n${chapter.content}` }],
    maxTokens: 4096,
    temperature: 0.2,
    purpose: 'check'
  }
}

export interface CheckIssue {
  type: string
  quote: string
  issue: string
  fix: string
}

export function parseCheckResult(text: string): { issues: CheckIssue[]; parsed: boolean } {
  const arr = extractJsonArray(text)
  if (!arr) return { issues: [], parsed: false }
  const issues = arr
    .map((item) => item as Record<string, unknown>)
    .map((r) => ({
      type: String(r.type ?? ''),
      quote: String(r.quote ?? ''),
      issue: String(r.issue ?? ''),
      fix: String(r.fix ?? '')
    }))
    .filter((i) => i.issue)
  return { issues, parsed: true }
}

export async function buildReviewRequest(
  projectId: string,
  outlineId: string
): Promise<ChatParams> {
  const outline = store.getOutline(outlineId)
  const chapter = outline ? store.getChapterByOutline(outlineId) : null
  if (!outline || !chapter?.content.trim()) throw new Error('该章节还没有正文，无法评审')
  const ctx = await buildChapterContext(projectId, outlineId)
  const system = [skillBody('chapter-reviewer'), ctx.system].filter(Boolean).join('\n\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: `请评审以下章节正文：\n\n${chapter.content}` }],
    maxTokens: 4096,
    temperature: 0.2,
    purpose: 'review'
  }
}

const REVIEW_DIMS = [
  '设定一致性',
  '角色行为',
  '节奏',
  '叙事连贯',
  '伏笔',
  '钩子',
  '审美品质'
] as const

export function parseReviewResult(text: string): { result: ReviewResult; raw: string } {
  const obj = extractJsonObject(text)
  if (!obj)
    return { result: { verdict: 'polish', scores: [], summary: '', parsed: false }, raw: text }
  const rawProblems = Array.isArray(obj.problems)
    ? (obj.problems as Array<Record<string, unknown>>)
    : []
  // 只认证据：无原文引证的问题丢弃
  const problems = rawProblems
    .map((p) => ({
      dim: String(p.dim ?? '').trim(),
      severity: p.severity === 'major' ? 'major' : 'minor',
      quote: String(p.quote ?? '').trim(),
      issue: String(p.issue ?? '').trim(),
      fix: String(p.fix ?? '').trim()
    }))
    .filter((p) => p.quote && p.issue)
  // 程序算分：每维 10 分起扣，major -3 / minor -1，下限 0
  const scores: ReviewScore[] = REVIEW_DIMS.map((dim) => {
    const mine = problems.filter(
      (p) => p.dim === dim || (p.dim && dim.includes(p.dim)) || p.dim?.includes(dim)
    )
    const penalty = mine.reduce((a, p) => a + (p.severity === 'major' ? 3 : 1), 0)
    const score = Math.max(0, 10 - penalty)
    const first = mine[0]
    return {
      dim,
      score,
      quote: first?.quote ?? '',
      comment:
        mine.length === 0
          ? '未见带引证的问题'
          : mine
              .map(
                (p) =>
                  `${p.severity === 'major' ? '【重】' : ''}${p.issue}${p.fix ? `（建议：${p.fix}）` : ''}`
              )
              .join('；')
    }
  })
  const total = scores.reduce((a, s) => a + s.score, 0)
  const anyLow = scores.some((s) => s.score <= 4)
  const hookOrAestheticLow = scores.some(
    (s) => (s.dim === '钩子' || s.dim === '审美品质') && s.score <= 6
  )
  const verdict: ReviewResult['verdict'] = anyLow
    ? 'rewrite'
    : total < 50 || hookOrAestheticLow
      ? 'polish'
      : 'pass'
  return {
    result: { verdict, scores, summary: String(obj.summary ?? ''), parsed: true },
    raw: text
  }
}

export function buildExpandRequest(
  projectId: string,
  outlineId: string,
  targetWords: number
): ChatParams {
  const project = store.listProjects().find((x) => x.id === projectId)
  const outline = store.getOutline(outlineId)
  const chapter = outline ? store.getChapterByOutline(outlineId) : null
  if (!outline || !chapter?.content.trim()) throw new Error('该章节还没有正文，无法扩写')
  const system = [
    skillBody('chapter-expander'),
    project?.styleGuide && `【作品风格】\n${project.styleGuide}`
  ]
    .filter(Boolean)
    .join('\n\n')
  const user = `第${outline.chapterNo}章《${outline.title}》正文（当前 ${chapter.wordCount} 字）：\n\n${chapter.content}\n\n请诊断式扩写至约 ${targetWords} 字。`
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 16384,
    temperature: 0.6,
    purpose: 'expand'
  }
}

export function buildVolumeSummaryRequest(projectId: string, volume: number): ChatParams {
  const outlines = store
    .listOutlines(projectId)
    .filter((o) => o.volume === volume)
    .sort((a, b) => a.chapterNo - b.chapterNo)
  if (outlines.length === 0) throw new Error(`第 ${volume} 卷还没有大纲`)
  const withSummary = outlines.filter((o) => {
    const c = store.getChapterByOutline(o.id)
    return c && store.getSummary(c.id)
  })
  if (withSummary.length === 0) throw new Error(`第 ${volume} 卷还没有已定稿的章节摘要`)
  const chapterLines = outlines
    .map((o) => {
      const c = store.getChapterByOutline(o.id)
      const s = c ? store.getSummary(c.id) : null
      if (s) {
        return `第${o.chapterNo}章《${o.title}》：${s.summary}${s.timeline ? `（时间线：${s.timeline}）` : ''}`
      }
      return `第${o.chapterNo}章《${o.title}》（未写/未定稿）：${o.synopsis.slice(0, 80)}`
    })
    .join('\n')
  const foreLines = store
    .listForeshadows(projectId)
    .filter((f) => f.status === 'open' && f.plantedChapter)
    .map((f) => `- ${f.content}（埋于${f.plantedChapter}）`)
    .join('\n')
  const stateLines = withSummary
    .flatMap((o) => {
      const c = store.getChapterByOutline(o.id)
      const s = c ? store.getSummary(c.id) : null
      return s ? s.characterStates : []
    })
    .filter((cs) => cs.name)
    .join('；')
  const system = skillBody('volume-summarizer')
  const user = [
    `请生成第 ${volume} 卷的卷摘要。`,
    `【各章摘要】\n${chapterLines}`,
    foreLines && `【当前未回收伏笔（参考）】\n${foreLines}`,
    stateLines && `【末章人物状态（参考）】${stateLines}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 2048,
    temperature: 0.3,
    purpose: 'summary'
  }
}

export function applyVolumeSummaryResult(
  projectId: string,
  volume: number,
  text: string
): { volume: number; summaryChars: number; parsed: boolean } {
  const summary = text.trim()
  if (!summary) return { volume, summaryChars: 0, parsed: false }
  store.saveVolumeSummary(projectId, volume, summary)
  return { volume, summaryChars: summary.length, parsed: true }
}
