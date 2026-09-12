import type {
  BuiltContext,
  ChatParams,
  OutlineGenParams,
  WorldbuildEntry,
  WorldbuildGenParams,
  WorldbuildPreviewEntry
} from '../shared/types'
import { splitHeadingHashtags, splitTags } from '../shared/tags'
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

export interface WorldbuildRetrieval {
  types: string[]
  tags: string[]
  entries: WorldbuildEntry[]
}export interface WorldbuildIndex {
  types: string[]
  tagCounts: Array<{ name: string; count: number }>
  entries: WorldbuildEntry[]
}

export function buildWorldbuildIndex(projectId: string): WorldbuildIndex {
  const entries = store.listWorldbuild(projectId)
  const tagCounts = new Map<string, number>()
  for (const e of entries) {
    for (const t of splitTags(e.tags)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  }
  return {
    types: store.listWorldbuildTypes(projectId),
    tagCounts: [...tagCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    entries
  }
}

export function buildWorldbuildRetrieveRequest(p: WorldbuildGenParams): ChatParams | null {
  const index = buildWorldbuildIndex(p.projectId)
  if (index.entries.length === 0) return null
  const typeLine = index.types.map((t) => {
    const n = index.entries.filter((e) => e.category === t).length
    return `${t}(${n})`
  })
  const tagLine =
    index.tagCounts.length > 0
      ? index.tagCounts.map((t) => `${t.name}(${t.count})`).join('、')
      : '（暂无标签）'
  const entryLines = index.entries
    .map((e) => {
      const tags = splitTags(e.tags)
      return `- [${e.category}] ${e.title}${tags.length > 0 ? ` #${tags.join(' #')}` : ''}`
    })
    .join('\n')
  const user = [
    `生成需求：${p.title.trim() ? `【${p.title.trim()}】` : ''}${p.brief}`,
    p.focus?.tag && `用户当前聚焦标签：#${p.focus.tag}（优先考虑与该标签相关的类型与标签）`,
    p.focus?.type && `用户当前聚焦类型：${p.focus.type}（优先考虑该类型）`,
    '',
    '现有类型清单：' + (typeLine.length > 0 ? typeLine.join('、') : '（暂无）'),
    `现有标签清单：${tagLine}`,
    '全部条目：',
    entryLines,
    '',
    '任务：从上述类型与标签中，选出与生成需求最相关、生成时需要参考原文以保持自洽的类型与标签（各最多 6 个，宁缺毋滥）。',
    '只输出 JSON，不要输出其他内容，格式：{"types":["…"],"tags":["…"]}'
  ]
    .filter((line) => line !== undefined)
    .join('\n')
  return {
    model: '',
    messages: [{ role: 'user', content: user }],
    maxTokens: 512,
    temperature: 0.1,
    purpose: 'outline'
  }
}

export function resolveWorldbuildRetrieval(
  p: WorldbuildGenParams,
  index: WorldbuildIndex,
  text: string
): WorldbuildRetrieval {
  const obj = extractJsonObject(text)
  const types = Array.isArray(obj?.types) ? obj.types.map(String).map((s) => s.trim()).filter(Boolean) : []
  const tags = Array.isArray(obj?.tags) ? obj.tags.map(String).map((s) => s.trim()).filter(Boolean) : []
  const typeSet = new Set(types)
  const tagSet = new Set(tags)
  let related = index.entries.filter(
    (e) => typeSet.has(e.category) || splitTags(e.tags).some((t) => tagSet.has(t))
  )
  if (related.length === 0 && (types.length > 0 || tags.length > 0)) {
    related = index.entries.filter(
      (e) =>
        types.some((t) => e.category.includes(t)) ||
        splitTags(e.tags).some((et) => tags.some((t) => et.includes(t) || t.includes(et)))
    )
  }
  const CLIP = 600
  const BUDGET = 8000
  const picked: WorldbuildEntry[] = []
  let used = 0
  for (const e of related) {
    const cost = Math.min(CLIP, e.content.length)
    if (used + cost > BUDGET) break
    picked.push(e)
    used += cost
  }
  return { types, tags, entries: picked }
}

export function buildWorldbuildRequest(
  p: WorldbuildGenParams,
  retrieval?: WorldbuildRetrieval
): ChatParams {
  const project = store.listProjects().find((x) => x.id === p.projectId)
  const index = buildWorldbuildIndex(p.projectId)
  const typeLine =
    index.types.length > 0
      ? `【可用类型（每条目恰属一个类型，只能从此清单选；仅当内容确实不属于任何类型时才可新建，本次最多新建 1 个）】\n${index.types.join('、')}`
      : '【可用类型】暂无，可为首个条目新建类型'
  const tagLine =
    index.tagCounts.length > 0
      ? `【现有标签（按使用次数排序，必须优先复用；新建标签须是可被多个条目共享的主题词，禁止一次性标签；标签不得与类型重名）】\n${index.tagCounts.map((t) => `${t.name}(${t.count})`).join('、')}`
      : '【现有标签】暂无，可按纪律新建'
  const related =
    retrieval && retrieval.entries.length > 0
      ? retrieval.entries
          .map((e) => {
            const tags = splitTags(e.tags)
            const head = `### [${e.category}] ${e.title}${tags.length > 0 ? ` #${tags.join(' #')}` : ''}`
            return `${head}\n${e.content.slice(0, 600)}`
          })
          .join('\n\n')
      : ''
  const categories = p.categories.filter((c) => c.trim())
  const countLine =
    p.count && p.count > 0 ? `正好 ${p.count} 个条目` : '根据需求规模自行决定，不设上限'
  const categoryLine = categories.length
    ? `- 条目类型：只能从「${categories.join('、')}」中选择，内容必须聚焦所选类型，禁止写入其他类型的设定`
    : p.focus?.type
      ? `- 条目类型：本组条目围绕用户聚焦的类型「${p.focus.type}」生成（若个别条目内容确实不属于该类型可另选更合适的类型）`
      : '- 条目类型：优先从提供的可用类型清单中选择'
  const focusLine = p.focus?.tag
    ? `- 聚焦方向：本组条目围绕主题标签「#${p.focus.tag}」扩展，与该主题相关的新设定优先`
    : null
  const titleLine = p.title.trim()
    ? `- 总主题：${p.title.trim()}（各条目标题由你围绕该主题拟定，禁止把全部内容挤进一个条目）`
    : '- 各条目标题由你根据生成需求拟定'
  const system = [
    skillBody('worldbuilder'),
    project?.styleGuide && `【作品风格】\n${project.styleGuide}`,
    typeLine,
    tagLine,
    related &&
      `【相关已有条目（仅作自洽性参考：不得重复或扩写其中内容，新条目须与之咬合不矛盾；正文中可用 [[条目名]] 引用它们）】\n${related}`
  ]
    .filter(Boolean)
    .join('\n\n')
  const user = [
    '请为世界观生成一组条目：',
    categoryLine,
    focusLine,
    titleLine,
    `- 生成需求：${p.brief}`,
    `- 条目数量：${countLine}；当需求横跨多个方面时必须拆分为多个条目，每个条目只承载一个主题`,
    `- 标签数量：每条目 2-6 个标签，写在该条目标题行尾`,
    '',
    '输出格式（严格遵守，除此之外不要输出任何内容）：',
    '每个条目以一行「## [类型] 标题 #标签1 #标签2」开头，随后是该条目正文（markdown 要点式）。',
    '条目之间相互引用时，在正文中使用 [[条目标题]] 链接（例如总览条目引用各个具体条目，具体条目也回链总览）。',
    '不要输出总开场白、总结语或对格式本身的解释。'
  ]
    .filter((line) => line !== null)
    .join('\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 8192,
    temperature: 0.7,
    purpose: 'outline'
  }
}

export interface ParsedWorldbuildEntry {
  category: string
  title: string
  tags: string[]
  content: string
}

export function parseWorldbuildEntries(
  text: string,
  fallbackCategories: string[]
): ParsedWorldbuildEntry[] {
  const allowed = fallbackCategories.filter((c) => c.trim())
  const fallbackCategory = (): string => allowed[0] ?? '其他'
  const sections: ParsedWorldbuildEntry[] = []
  const lines = text.split(/\r?\n/)
  let current: ParsedWorldbuildEntry | null = null
  const heading = /^#{1,3}\s*(?:\[([^\]]*)\]\s*)?(.+?)\s*$/
  for (const line of lines) {
    const m = heading.exec(line)
    if (m && (m[1] || sections.length > 0 || current)) {
      if (current) sections.push(current)
      const { title, tags } = splitHeadingHashtags(m[2])
      const category = (m[1] ?? '').trim() || fallbackCategory()
      current = {
        category: category.slice(0, 12),
        title: title || '未命名条目',
        tags,
        content: ''
      }
    } else if (current) {
      current.content += (current.content ? '\n' : '') + line
    }
  }
  if (current) sections.push(current)
  const cleaned = sections
    .map((s) => ({ ...s, content: s.content.replace(/^\n+|\n+$/g, '') }))
    .filter((s) => s.title || s.content)
  if (cleaned.length > 0) return cleaned
  return [
    {
      category: fallbackCategory(),
      title: '未命名条目',
      tags: [],
      content: text.trim()
    }
  ]
}

export function previewWorldbuildResult(
  p: WorldbuildGenParams,
  text: string
): WorldbuildPreviewEntry[] {
  const parsed = parseWorldbuildEntries(text, p.categories)
  return normalizeWorldbuildParsed(p.projectId, parsed)
}

function normalizeWorldbuildParsed(
  projectId: string,
  parsed: ParsedWorldbuildEntry[]
): WorldbuildPreviewEntry[] {
  const knownTypes = new Set(store.listWorldbuildTypes(projectId))
  let newTypeBudget = 1
  return parsed.map((e) => {
    const isNewType = !knownTypes.has(e.category)
    if (isNewType && newTypeBudget > 0) {
      knownTypes.add(e.category)
      newTypeBudget--
    }
    const category = knownTypes.has(e.category) ? e.category : '其他'
    const tags = splitTags(e.tags.join(','))
      .filter((t) => !knownTypes.has(t))
      .slice(0, 6)
    return { category, title: e.title, tags, content: e.content, isNewType }
  })
}

export function saveWorldbuildBatch(
  projectId: string,
  entries: WorldbuildPreviewEntry[]
): { entryIds: string[]; createdTypes: string[] } {
  const knownTypes = new Set(store.listWorldbuildTypes(projectId))
  const entryIds: string[] = []
  const createdTypes: string[] = []
  let newTypeBudget = 1
  for (const e of entries) {
    if (!knownTypes.has(e.category)) {
      if (newTypeBudget > 0) {
        try {
          store.createWorldbuildType(projectId, e.category)
          knownTypes.add(e.category)
          createdTypes.push(e.category)
          newTypeBudget--
        } catch {
          /* 重名等冲突时放弃新建 */
        }
      }
    }
    const tags = splitTags(e.tags.join(','))
      .filter((t) => !knownTypes.has(t))
      .slice(0, 6)
    const saved = store.saveWorldbuild({
      projectId,
      category: knownTypes.has(e.category) ? e.category : '其他',
      title: e.title,
      tags: tags.join(','),
      content: e.content
    })
    entryIds.push(saved.id)
  }
  return { entryIds, createdTypes }
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

