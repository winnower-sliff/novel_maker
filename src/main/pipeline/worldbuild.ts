import { splitHeadingHashtags, splitTags } from '../../shared/tags'
import type {
  ChatParams,
  WorldbuildEntry,
  WorldbuildGenParams,
  WorldbuildPreviewEntry
} from '../../shared/types'
import * as store from '../store'
import { extractJsonObject, skillBody } from './util'

export interface WorldbuildRetrieval {
  types: string[]
  tags: string[]
  entries: WorldbuildEntry[]
}
export interface WorldbuildIndex {
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
    p.tags &&
      p.tags.length > 0 &&
      `用户指定主题标签：${p.tags.map((t) => `#${t}`).join('、')}（优先考虑与这些主题相关的类型与标签）`,
    p.categories.filter(Boolean).length > 0 &&
      `用户限定类型：${p.categories.filter(Boolean).join('、')}（优先考虑这些类型下的条目）`,
    '',
    `现有类型清单：${typeLine.length > 0 ? typeLine.join('、') : '（暂无）'}`,
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
  _p: WorldbuildGenParams,
  index: WorldbuildIndex,
  text: string
): WorldbuildRetrieval {
  const obj = extractJsonObject(text)
  const types = Array.isArray(obj?.types)
    ? obj.types
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
    : []
  const tags = Array.isArray(obj?.tags)
    ? obj.tags
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
    : []
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
            return `${head}\n${e.content.slice(0, p.allowUpdate ? 1200 : 600)}`
          })
          .join('\n\n')
      : ''
  const categories = p.categories.filter((c) => c.trim())
  const countLine =
    p.count && p.count > 0
      ? `正好 ${p.count} 个条目`
      : '宏大构建：不少于 50 个条目（建议 50-80 个），像百科全书一样从多个维度铺开世界规模'
  const categoryLine = categories.length
    ? `- 条目类型：只能从「${categories.join('、')}」中选择，内容必须聚焦所选类型，禁止写入其他类型的设定`
    : '- 条目类型：优先从提供的可用类型清单中选择'
  const focusTags = (p.tags ?? []).filter((t) => t.trim())
  const focusLine = focusTags.length
    ? `- 聚焦方向：本组条目围绕主题标签「${focusTags.map((t) => `#${t}`).join('」「')}」扩展，与这些主题相关的新设定优先`
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
      (p.allowUpdate
        ? `【相关已有条目（供参考并允许修订：新条目须与它们咬合不矛盾，正文中可用 [[条目名]] 引用它们（仅限世界观条目，禁止链人物名）。若新设定与某条已有条目矛盾或需要补充完善，可输出该条目的修订版：标题行标题必须与原条目逐字一致，正文为融合新设定后的完整内容（不得丢失原有有效信息），类型与标签按修订后内容重新标注；只能修订上面列出的条目，禁止凭空输出未列出的条目标题，无必要时不要修订）】\n${related}`
        : `【相关已有条目（仅作自洽性参考：不得重复或扩写其中内容，新条目须与之咬合不矛盾；正文中可用 [[条目名]] 引用它们，仅限世界观条目，禁止链人物名）】\n${related}`)
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
    '- 条目篇幅：正文保持简短，每条 2-4 个要点、共约 50-150 字，信息密度优先，禁止长篇大论',
    '- 交叉链接：动笔前先规划好本批次全部条目的标题清单，再逐条输出；每个条目正文至少包含 2 个 [[条目标题]] 链接（指向本批次其他条目或已有条目），总览/格局类条目需引用其下全部分区条目，让整组条目织成密集网络',
    '- 链接目标纪律：[[ ]] 只允许链世界观条目标题，严禁链人物名、章节名；提及人物直接写名字或纯文本描述，不加双方括号',
    '- 标签即链接：当条目使用了与其他条目标题相同的主题词作标签（如 #矮人 对应「矮人」条目）时，正文必须包含 [[矮人]] 链接；标签管归类、链接管关联，不可互相替代',
    '- 标签（必填）：每个条目标题行尾必须带 2-6 个 #标签，禁止无标签条目；优先复用现有标签，找不到合适的就新建可被多个条目共享的上位主题标签（体系名/时代名/事件名/族群名/地域名/组织类别等）',
    '',
    '输出格式（严格遵守，除此之外不要输出任何内容）：',
    '每个条目以一行「## [类型] 标题 #标签1 #标签2」开头，随后是该条目正文（markdown 要点式）。',
    ...(p.allowUpdate
      ? [
          '修订已有条目时同样以「## [类型] 标题」开头，标题必须与原条目逐字一致，正文输出融合新设定后的完整修订内容；修订条目不计入上述条目数量要求。'
        ]
      : []),
    '条目之间相互引用时，在正文中使用 [[条目标题]] 链接（例如总览条目引用各个具体条目，具体条目也回链总览）；链接只指向世界观条目，禁止链人物名。',
    '不要输出总开场白、总结语或对格式本身的解释。'
  ]
    .filter((line) => line !== null)
    .join('\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 65536,
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
  if (!text.trim()) return []
  const parsed = parseWorldbuildEntries(text, p.categories)
  return normalizeWorldbuildParsed(p.projectId, parsed)
}

function hasWikiLink(content: string, title: string): boolean {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\[\\[\\s*${escaped}\\s*\\]\\]`).test(content)
}

function linkMissingTags(entries: WorldbuildPreviewEntry[], existingTitles: Set<string>): void {
  const linkableTitles = new Set([...existingTitles, ...entries.map((e) => e.title.trim())])
  for (const e of entries) {
    const selfTitle = e.title.trim()
    const missing = [
      ...new Set(
        e.tags
          .map((t) => t.trim())
          .filter(
            (t) => t && t !== selfTitle && linkableTitles.has(t) && !hasWikiLink(e.content, t)
          )
      )
    ]
    if (missing.length > 0) {
      e.content += `${e.content ? '\n\n' : ''}关联：${missing.map((t) => `[[${t}]]`).join('、')}`
    }
  }
}

export function normalizeWorldbuildParsed(
  projectId: string,
  parsed: ParsedWorldbuildEntry[],
  opts?: { newTypeBudget?: number }
): WorldbuildPreviewEntry[] {
  const knownTypes = new Set(store.listWorldbuildTypes(projectId))
  const seenTitles = new Set<string>()
  let newTypeBudget = opts?.newTypeBudget ?? 1
  const out: WorldbuildPreviewEntry[] = []
  for (const e of parsed) {
    const titleKey = e.title.trim()
    if (seenTitles.has(titleKey)) continue
    seenTitles.add(titleKey)
    const isNewType = !knownTypes.has(e.category)
    if (isNewType && newTypeBudget > 0) {
      knownTypes.add(e.category)
      newTypeBudget--
    }
    const category = knownTypes.has(e.category) ? e.category : '其他'
    const tags = splitTags(e.tags.join(','))
      .filter((t) => !knownTypes.has(t))
      .slice(0, 6)
    out.push({ category, title: e.title, tags, content: e.content, isNewType })
  }
  linkMissingTags(out, new Set(store.listWorldbuild(projectId).map((e) => e.title.trim())))
  return out
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

export function commitWorldbuildChunk(
  projectId: string,
  rawText: string,
  categories: string[],
  opts: { allowNewType: boolean; taskEntryIds: string[]; allowUpdate?: boolean }
): { entryIds: string[]; createdTypes: string[]; updatedIds: string[]; revisedIds: string[] } {
  const existing = store.listWorldbuild(projectId)
  const taskIds = new Set(opts.taskEntryIds)
  const existingByTitle = new Map<string, WorldbuildEntry>()
  for (const e of existing) {
    const key = e.title.trim()
    if (key && !existingByTitle.has(key)) existingByTitle.set(key, e)
  }
  const parsed = parseWorldbuildEntries(rawText, categories).filter(
    (e) => e.title.trim() && e.title.trim() !== '未命名条目' && e.content.trim()
  )
  const normalized = normalizeWorldbuildParsed(projectId, parsed, {
    newTypeBudget: opts.allowNewType ? 1 : 0
  })
  const toInsert: WorldbuildPreviewEntry[] = []
  const updates: Array<{ id: string; entry: WorldbuildPreviewEntry; revised: boolean }> = []
  const claimedTitles = new Set<string>()
  for (const e of normalized) {
    const key = e.title.trim()
    if (claimedTitles.has(key)) continue
    claimedTitles.add(key)
    const hit = existingByTitle.get(key)
    if (hit) {
      if (taskIds.has(hit.id)) updates.push({ id: hit.id, entry: e, revised: false })
      else if (opts.allowUpdate) updates.push({ id: hit.id, entry: e, revised: true })
      continue
    }
    toInsert.push(e)
  }
  const entryIds: string[] = []
  const updatedIds: string[] = []
  const revisedIds: string[] = []
  for (const { id, entry, revised } of updates) {
    store.saveWorldbuild({
      id,
      projectId,
      category: entry.category,
      title: entry.title,
      tags: entry.tags.length > 0 ? entry.tags.join(',') : undefined,
      content: entry.content
    })
    if (revised) revisedIds.push(id)
    else updatedIds.push(id)
    entryIds.push(id)
  }
  let createdTypes: string[] = []
  if (toInsert.length > 0) {
    const r = saveWorldbuildBatch(projectId, toInsert)
    entryIds.push(...r.entryIds)
    createdTypes = r.createdTypes
  }
  return { entryIds, createdTypes, updatedIds, revisedIds }
}

export function relinkWorldbuildEntries(projectId: string, entryIds: string[]): number {
  const idSet = new Set(entryIds)
  const entries = store.listWorldbuild(projectId).filter((e) => idSet.has(e.id))
  if (entries.length === 0) return 0
  const allTitles = new Set(
    store
      .listWorldbuild(projectId)
      .map((e) => e.title.trim())
      .filter(Boolean)
  )
  const conv = entries.map((e) => ({
    category: e.category,
    title: e.title,
    tags: splitTags(e.tags),
    content: e.content,
    isNewType: false
  }))
  const before = conv.map((e) => e.content)
  linkMissingTags(conv, allTitles)
  let updated = 0
  conv.forEach((e, i) => {
    if (e.content !== before[i]) {
      store.saveWorldbuild({
        id: entries[i].id,
        projectId,
        category: e.category,
        title: e.title,
        tags: e.tags.join(','),
        content: e.content
      })
      updated++
    }
  })
  return updated
}
