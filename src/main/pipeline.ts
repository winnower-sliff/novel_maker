import type { BuiltContext, ChatParams, OutlineGenParams } from '../shared/types'
import { buildChapterContext } from './context'
import { getSkill } from './skills'
import * as store from './store'

export function skillBody(name: string): string {
  const f = getSkill(`${name}.md`)
  if (!f) return ''
  const match = /^---\r?\n[\s\S]*?\r?\n---/.exec(f.raw)
  return match ? f.raw.slice(match[0].length).trim() : f.raw
}

function sliceBetween(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

export function extractJsonArray(text: string): unknown[] | null {
  const raw = sliceBetween(text, '[', ']')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const raw = sliceBetween(text, '{', '}')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function buildOutlineRequest(p: OutlineGenParams): ChatParams {
  const project = store.listProjects().find((x) => x.id === p.projectId)
  const wb = store
    .listWorldbuild(p.projectId)
    .map((e) => `- [${e.category}] ${e.title}：${e.content.slice(0, 200)}`)
    .join('\n')
  const chars = store
    .listCharacters(p.projectId)
    .map((c) => `- ${c.name}（${c.role || '未定位'}）：${c.card.slice(0, 200)}`)
    .join('\n')
  const system = [
    skillBody('outline-architect'),
    project?.styleGuide && `【作品风格】\n${project.styleGuide}`,
    wb && `【已有世界观】\n${wb}`,
    chars && `【已有人物】\n${chars}`
  ]
    .filter(Boolean)
    .join('\n\n')
  const user = `核心创意：${p.idea}\n\n请生成第 ${p.volume} 卷、第 ${p.startNo} 章到第 ${p.startNo + p.count - 1} 章的大纲（共 ${p.count} 章），严格按约定的 JSON 数组格式输出，不要输出其他内容。`
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 8192,
    temperature: 0.7,
    purpose: 'outline'
  }
}

export function buildChapterRequest(
  projectId: string,
  outlineId: string
): { params: ChatParams; ctx: BuiltContext } {
  const ctx = buildChapterContext(projectId, outlineId)
  const system = [skillBody('chapter-writer'), ctx.system].filter(Boolean).join('\n\n')
  return {
    params: {
      model: '',
      system,
      messages: [{ role: 'user', content: ctx.user }],
      maxTokens: 8192,
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
  const system = [
    skillBody('summarizer'),
    chars && `本书人物名单：${chars}`
  ]
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

export function buildPolishRequest(projectId: string, outlineId: string): ChatParams {
  const project = store.listProjects().find((x) => x.id === projectId)
  const outline = store.getOutline(outlineId)
  const chapter = outline ? store.getChapterByOutline(outlineId) : null
  if (!outline || !chapter || !chapter.content.trim()) throw new Error('该章节还没有正文，无法润色')
  const system = [
    skillBody('style-polisher'),
    project?.styleGuide && `【作品风格】\n${project.styleGuide}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: '',
    system,
    messages: [
      { role: 'user', content: `第${outline.chapterNo}章《${outline.title}》正文：\n\n${chapter.content}` }
    ],
    maxTokens: 8192,
    temperature: 0.5,
    purpose: 'polish'
  }
}

export function buildCheckRequest(projectId: string, outlineId: string): ChatParams {
  const outline = store.getOutline(outlineId)
  const chapter = outline ? store.getChapterByOutline(outlineId) : null
  if (!outline || !chapter || !chapter.content.trim()) throw new Error('该章节还没有正文，无法检查')
  const ctx = buildChapterContext(projectId, outlineId)
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

export function buildCharacterRequest(projectId: string, brief: string): ChatParams {
  const project = store.listProjects().find((x) => x.id === projectId)
  const wb = store
    .listWorldbuild(projectId)
    .map((e) => `- [${e.category}] ${e.title}`)
    .join('\n')
  const chars = store
    .listCharacters(projectId)
    .map((c) => `- ${c.name}（${c.role || '未定位'}）`)
    .join('\n')
  const system = [
    skillBody('character-smith'),
    project?.styleGuide && `【作品风格】\n${project.styleGuide}`,
    wb && `【世界观条目】\n${wb}`,
    chars && `【已有人物（避免定位重复，需咬合关系网）】\n${chars}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: brief }],
    maxTokens: 4096,
    temperature: 0.8,
    purpose: 'outline'
  }
}

export function guessCharacterName(card: string, fallback: string): string {
  const heading = /^#{1,3}\s*(.+)$/m.exec(card)
  if (heading) {
    const raw = heading[1].trim()
    const name = raw.replace(/[（(【].*$/, '').trim()
    if (name) return name.slice(0, 20)
  }
  return fallback || '新人物'
}

export function buildWorldbuildRequest(projectId: string, brief: string): ChatParams {
  const project = store.listProjects().find((x) => x.id === projectId)
  const existing = store
    .listWorldbuild(projectId)
    .map((e) => `- [${e.category}] ${e.title}`)
    .join('\n')
  const system = [
    skillBody('worldbuilder'),
    project?.styleGuide && `【作品风格】\n${project.styleGuide}`,
    existing && `【已有条目（保持自洽，不要重复）】\n${existing}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: brief }],
    maxTokens: 4096,
    temperature: 0.7,
    purpose: 'outline'
  }
}

export function applyOutlineResult(
  p: OutlineGenParams,
  text: string
): { created: number; skipped: number; parsed: boolean } {
  const arr = extractJsonArray(text)
  if (!arr) return { created: 0, skipped: 0, parsed: false }
  let created = 0
  let skipped = 0
  const existing = new Set(store.listOutlines(p.projectId).map((o) => `${o.volume}:${o.chapterNo}`))
  for (const item of arr) {
    const r = item as Record<string, unknown>
    const volume = Number(r.volume) || p.volume
    const chapterNo = Number(r.chapter_no ?? r.chapterNo)
    if (!chapterNo || Number.isNaN(chapterNo)) continue
    if (existing.has(`${volume}:${chapterNo}`)) {
      skipped++
      continue
    }
    store.saveOutline({
      projectId: p.projectId,
      volume,
      chapterNo,
      title: String(r.title ?? ''),
      synopsis: String(r.synopsis ?? ''),
      status: 'draft'
    })
    existing.add(`${volume}:${chapterNo}`)
    created++
  }
  return { created, skipped, parsed: true }
}

export function applySummaryResult(
  projectId: string,
  outlineId: string,
  text: string
): { planted: number; resolved: number; parsed: boolean } {
  const obj = extractJsonObject(text)
  const outline = store.listOutlines(projectId).find((o) => o.id === outlineId)
  const chapter = outline ? store.getChapterByOutline(outlineId) : null
  if (!obj || !outline || !chapter) return { planted: 0, resolved: 0, parsed: !!obj }

  store.saveSummary(chapter.id, {
    summary: String(obj.summary ?? ''),
    events: Array.isArray(obj.events) ? obj.events.map(String) : [],
    timeline: String(obj.timeline ?? ''),
    characterStates: Array.isArray(obj.character_states)
      ? (obj.character_states as Array<Record<string, unknown>>).map((cs) => ({
          name: String(cs.name ?? ''),
          state: String(cs.state ?? '')
        }))
      : [],
    foreshadowsPlanted: Array.isArray(obj.foreshadows_planted)
      ? (obj.foreshadows_planted as Array<Record<string, unknown>>).map((f) => ({
          content: String(f.content ?? ''),
          quote: String(f.quote ?? '')
        }))
      : [],
    foreshadowsResolved: Array.isArray(obj.foreshadows_resolved)
      ? obj.foreshadows_resolved.map(String)
      : []
  })

  const existingOpen = store.listForeshadows(projectId).filter((f) => f.status === 'open')
  let plantedCount = 0
  for (const f of Array.isArray(obj.foreshadows_planted)
    ? (obj.foreshadows_planted as Array<Record<string, unknown>>)
    : []) {
    const content = String(f.content ?? '').trim()
    if (!content) continue
    if (existingOpen.some((x) => x.content === content)) continue
    store.saveForeshadow({
      projectId,
      content,
      plantedChapter: `第${outline.chapterNo}章`,
      status: 'open'
    })
    plantedCount++
  }

  let resolvedCount = 0
  const resolvedList = Array.isArray(obj.foreshadows_resolved)
    ? obj.foreshadows_resolved.map(String)
    : []
  for (const content of resolvedList) {
    const target = existingOpen.find(
      (x) => content.includes(x.content) || x.content.includes(content)
    )
    if (target) {
      store.saveForeshadow({
        id: target.id,
        projectId,
        content: target.content,
        plantedChapter: target.plantedChapter,
        status: 'resolved',
        resolvedChapter: `第${outline.chapterNo}章`
      })
      resolvedCount++
    }
  }

  return { planted: plantedCount, resolved: resolvedCount, parsed: true }
}
