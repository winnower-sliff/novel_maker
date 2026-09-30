import { splitHeadingHashtags, splitTags } from '../shared/tags'
import type {
  BuiltContext,
  ChatParams,
  OutlineGenParams,
  OutlineItem,
  PremiseDraftResult,
  ReviewResult,
  ReviewScore,
  WorldbuildEntry,
  WorldbuildGenParams,
  WorldbuildPreviewEntry
} from '../shared/types'
import { buildChapterContext } from './context'
import { enqueueEmbedding } from './embedding'
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
  const outlineCtx = store
    .listOutlines(p.projectId)
    .filter((o) => o.volume === p.volume)
    .sort((a, b) => a.chapterNo - b.chapterNo)
    .map((o) => `- 第${o.chapterNo}章《${o.title}》：${o.synopsis.slice(0, 200)}`)
    .join('\n')
  const openFore = store
    .listForeshadows(p.projectId)
    .filter((f) => f.status === 'open')
    .map(
      (f) =>
        `- ${f.content}（埋于${f.plantedChapter || '?'}${f.plannedResolve ? `，计划回收：${f.plannedResolve}` : ''}${f.priority ? `，优先级：${f.priority}` : ''}）`
    )
    .join('\n')
  const system = [
    skillBody('outline-architect'),
    project?.styleGuide && `【作品风格】\n${project.styleGuide}`,
    wb && `【已有世界观】\n${wb}`,
    chars && `【已有人物】\n${chars}`,
    openFore &&
      `【未回收伏笔台账（规划新章节时应安排合理回收点，并在对应章节的 foreshadow_ops 中写明）】\n${openFore}`,
    outlineCtx &&
      (p.allowUpdate
        ? `【第 ${p.volume} 卷已有大纲（新章节须与之自然衔接；若新创意要求调整已有章节，可在结果中输出该章的修订条目——volume 与 chapter_no 与原章保持一致，synopsis 为融合后的完整修订梗概，该修订会覆盖更新原章梗概，无必要时不要修订）】\n${outlineCtx}`
        : `【第 ${p.volume} 卷已有大纲（新章节须与之自然衔接；已存在的同章号章节会被跳过，不会重复生成）】\n${outlineCtx}`)
  ]
    .filter(Boolean)
    .join('\n\n')
  const user = `核心创意：${p.idea}\n\n请生成第 ${p.volume} 卷、第 ${p.startNo} 章到第 ${p.startNo + p.count - 1} 章的大纲（共 ${p.count} 章），严格按约定的 JSON 数组格式输出，不要输出其他内容。`
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 16384,
    temperature: 0.7,
    purpose: 'outline'
  }
}

const PREMISE_SYSTEM = [
  '你是小说项目的首席策划。根据作品信息产出一份可直接执行的创作前置方案，严格输出单个 JSON 对象，不要 markdown 代码块、不要任何解释文字：',
  '{"worldbuild":{"brief":"世界观构建方向，200字以内，说明力量体系/势力/地理/历史等应如何设定","categories":["力量体系","势力"],"count":8},"characters":[{"name":"人物名","brief":"一句话人物需求（定位/特质/与主线的关系）"}],"outline":{"idea":"第一卷核心创意，200字以内，含主线起点与第一阶段冲突","count":20}}',
  '要求：',
  '- worldbuild.brief 给出明确的设定方向与基调，将作为下一步 AI 批量生成世界观条目的需求描述',
  '- characters 覆盖主线必需的核心人物（主角 1 名 + 关键配角/对手 3-5 名），brief 将作为逐个生成人物卡的需求描述',
  '- outline.idea 将作为下一步生成第一卷章节大纲的核心创意；outline.count 按目标字数估算（每章约 2500-3000 字），上限 40',
  '- categories 从 力量体系/地理/势力/历史/物品/其他 中选择 3-5 个最必要的',
  '- JSON 字符串内不得出现未转义的引号或换行'
].join('\n')

export function buildPremiseDraftRequest(projectId: string): ChatParams {
  const project = store.listProjects().find((x) => x.id === projectId)
  if (!project) throw new Error('项目不存在')
  const wbTitles = store
    .listWorldbuild(projectId)
    .map((e) => e.title)
    .slice(0, 30)
  const charNames = store
    .listCharacters(projectId)
    .map((c) => c.name)
    .slice(0, 30)
  const outlineCount = store.listOutlines(projectId).length
  const system = [
    PREMISE_SYSTEM,
    wbTitles.length > 0 &&
      `【已有世界观条目（方案应与之衔接补全，避免重复）】\n${wbTitles.join('、')}`,
    charNames.length > 0 && `【已有人物（方案应与之衔接补全，避免重复）】\n${charNames.join('、')}`,
    outlineCount > 0 && `【已有大纲 ${outlineCount} 章】`
  ]
    .filter(Boolean)
    .join('\n\n')
  const user = [
    `书名：${project.title}`,
    project.genre && `题材：${project.genre}`,
    project.targetWords > 0 && `目标字数：${project.targetWords}`,
    project.styleGuide && `风格指南：${project.styleGuide}`,
    '',
    '请输出创作前置方案 JSON。'
  ]
    .filter(Boolean)
    .join('\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 4096,
    temperature: 0.8,
    purpose: 'outline'
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function parsePremiseDraft(text: string): PremiseDraftResult {
  const obj = extractJsonObject(text)
  if (!obj) throw new Error('未能解析前置方案 JSON，请重试')
  const wb = (obj.worldbuild ?? {}) as Record<string, unknown>
  const outline = (obj.outline ?? {}) as Record<string, unknown>
  const rawChars = Array.isArray(obj.characters) ? obj.characters : []
  const characters = rawChars
    .map((c) => {
      const r = (c ?? {}) as Record<string, unknown>
      return {
        name: String(r.name ?? '')
          .trim()
          .slice(0, 20),
        brief: String(r.brief ?? '').trim()
      }
    })
    .filter((c) => c.name)
  const categories = Array.isArray(wb.categories)
    ? wb.categories.map((c) => String(c).trim()).filter(Boolean)
    : []
  const worldbuildBrief = String(wb.brief ?? '').trim()
  const outlineIdea = String(outline.idea ?? '').trim()
  if (!worldbuildBrief && !outlineIdea && characters.length === 0) {
    throw new Error('前置方案内容为空，请重试')
  }
  return {
    worldbuildBrief,
    worldbuildCategories:
      categories.length > 0 ? categories.slice(0, 8) : ['力量体系', '地理', '势力', '历史', '物品'],
    worldbuildCount: clampInt(wb.count, 3, 12, 8),
    characters,
    outlineIdea,
    outlineCount: clampInt(outline.count, 5, 40, 20)
  }
}

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
      return c && store.getSummary(c.id) ? store.getSummary(c.id)!.characterStates : []
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

export function buildStateSyncRequest(projectId: string, outlineId: string): ChatParams {
  const outline = store.getOutline(outlineId)
  const chapter = outline ? store.getChapterByOutline(outlineId) : null
  const summary = chapter ? store.getSummary(chapter.id) : null
  if (!outline || !summary) throw new Error('该章节还没有定稿摘要，无法同步人物状态')
  const characters = store.listCharacters(projectId)
  const affected = characters.filter((c) =>
    summary.characterStates.some(
      (cs) =>
        cs.name.trim() === c.name.trim() ||
        c.name.includes(cs.name.trim()) ||
        cs.name.includes(c.name.trim())
    )
  )
  if (affected.length === 0)
    return {
      model: '',
      system: '',
      messages: [{ role: 'user', content: 'noop' }],
      maxTokens: 16,
      temperature: 0,
      purpose: 'summary'
    }
  const blocks = affected
    .map((c) => {
      const changes = summary.characterStates
        .filter(
          (cs) =>
            cs.name.trim() === c.name.trim() ||
            c.name.includes(cs.name.trim()) ||
            cs.name.includes(c.name.trim())
        )
        .map((cs) => `- ${cs.state}`)
        .join('\n')
      return `### ${c.name}\n【当前状态文档】\n${c.state.trim() || '（空——请按分区结构新建：物品/能力/身心状态/关系/最近事件）'}\n【第${outline.chapterNo}章的变化】\n${changes}`
    })
    .join('\n\n')
  const system = skillBody('state-syncer')
  const user = `请合并以下人物的状态变化，输出每人更新后的完整状态文档：\n\n${blocks}`
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 4096,
    temperature: 0.2,
    purpose: 'summary'
  }
}

export interface ParsedCharacterState {
  name: string
  state: string
}

export function parseCharacterStates(text: string): ParsedCharacterState[] {
  const out: ParsedCharacterState[] = []
  let current: { name: string; body: string[] } | null = null
  for (const line of text.split(/\r?\n/)) {
    const m = /^#{1,3}\s*(.+?)\s*$/.exec(line)
    if (m && !/^[（(【]/.test(m[1])) {
      if (current?.body.join('').trim()) {
        out.push({ name: current.name, state: current.body.join('\n').trim() })
      }
      current = { name: m[1].replace(/[（(【].*$/, '').trim(), body: [] }
    } else if (current) {
      current.body.push(line)
    }
  }
  if (current?.body.join('').trim()) {
    out.push({ name: current.name, state: current.body.join('\n').trim() })
  }
  return out
}

export function applyStateSyncResult(
  projectId: string,
  text: string
): { updated: Array<{ id: string; name: string }>; parsed: boolean } {
  const parsed = parseCharacterStates(text)
  if (parsed.length === 0) return { updated: [], parsed: false }
  const characters = store.listCharacters(projectId)
  const updated: Array<{ id: string; name: string }> = []
  for (const p of parsed) {
    const hit = characters.find(
      (c) => c.name.trim() === p.name || c.name.includes(p.name) || p.name.includes(c.name.trim())
    )
    if (!hit) continue
    store.saveCharacter({
      id: hit.id,
      projectId,
      name: hit.name,
      state: p.state
    })
    updated.push({ id: hit.id, name: hit.name })
  }
  return { updated, parsed: updated.length > 0 }
}

export function buildCharacterRequest(
  projectId: string,
  brief: string,
  allowUpdate = false
): ChatParams {
  const project = store.listProjects().find((x) => x.id === projectId)
  const wb = store
    .listWorldbuild(projectId)
    .map((e) => `- [${e.category}] ${e.title}`)
    .join('\n')
  const characters = store.listCharacters(projectId)
  const chars = allowUpdate
    ? characters
        .map((c) => `### ${c.name}（${c.role || '未定位'}）\n${c.card.slice(0, 800)}`)
        .join('\n\n')
    : characters.map((c) => `- ${c.name}（${c.role || '未定位'}）`).join('\n')
  const tagCounts = new Map<string, number>()
  for (const c of characters) {
    for (const t of splitTags(c.tags)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  }
  const tagLine =
    tagCounts.size > 0
      ? `【已有标签（必须优先复用；新建标签须是可被多个人物共享的主题词）】\n${[...tagCounts.entries()].map(([name, count]) => `${name}(${count})`).join('、')}`
      : ''
  const system = [
    skillBody('character-smith'),
    project?.styleGuide && `【作品风格】\n${project.styleGuide}`,
    wb && `【世界观条目】\n${wb}`,
    tagLine,
    chars &&
      (allowUpdate
        ? `【已有人物（新人物的定位与关系须与他们咬合不矛盾。若有人物需要因新人物/新设定调整定位、关系或履历，可按输出格式约定追加修订卡；只能修订上面列出的人物）】\n${chars}`
        : `【已有人物（避免定位重复，需咬合关系网）】\n${chars}`)
  ]
    .filter(Boolean)
    .join('\n\n')
  const user = [
    brief,
    '',
    ...(allowUpdate
      ? [
          '输出格式（严格遵守）：',
          '- 首先输出新人物的完整人物卡，以「## 人物名 #标签1 #标签2」标题行开头（行尾必须带 2-4 个 #标签），正文为自由 markdown 要点式；',
          '- 若上面列出的已有人物中有人需要调整（如与新人物建立师徒/敌对关系、阵营变动、履历补写），在主卡之后追加修订卡：标题行写「## [修订] 原人物名 #标签1 #标签2」（原人物名须逐字一致；没有新标签时标题行可只写原人物名，表示沿用原标签），正文为修订后的完整人物卡（保留原有有效信息，只调整需要变化的部分）；',
          '- 没有需要修订的人物时不要输出任何修订卡，也不要输出总结或解释。'
        ]
      : [
          '输出格式（严格遵守）：',
          '- 每个人物以「## 人物名 #标签1 #标签2」标题行开头（行尾必须带 2-4 个 #标签），正文为自由 markdown 要点式人物卡；',
          '- 不要输出总开场白、总结语或对格式本身的解释。'
        ])
  ].join('\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: allowUpdate ? 8192 : 4096,
    temperature: 0.8,
    purpose: 'outline'
  }
}

export function guessCharacterName(card: string, fallback: string): string {
  const heading = /^#{1,3}\s*(.+)$/m.exec(card)
  if (heading) {
    const { title } = splitHeadingHashtags(heading[1])
    const name = title.replace(/[（(【].*$/, '').trim()
    if (name) return name.slice(0, 20)
  }
  return fallback || '新人物'
}

export interface ParsedCharacterRevision {
  name: string
  tags: string[]
  card: string
}

const REVISE_HEADING = /^#{1,3}\s*\[修订\]\s*(.+?)\s*$/

function stripNameDecorations(raw: string): string {
  return raw
    .replace(/[（(【].*$/, '')
    .trim()
    .slice(0, 20)
}

export function parseCharacterCards(text: string): {
  main: string
  mainTags: string[]
  revisions: ParsedCharacterRevision[]
} {
  const mainLines: string[] = []
  const revisions: ParsedCharacterRevision[] = []
  let current: { name: string; tags: string[]; body: string[] } | null = null
  for (const line of text.split(/\r?\n/)) {
    const m = REVISE_HEADING.exec(line)
    if (m) {
      if (current) {
        revisions.push({
          name: current.name,
          tags: current.tags,
          card: `## ${current.name}\n${current.body.join('\n').replace(/^\n+|\n+$/g, '')}`
        })
      }
      const { title, tags } = splitHeadingHashtags(m[1])
      current = { name: stripNameDecorations(title), tags, body: [] }
    } else if (current) {
      current.body.push(line)
    } else {
      mainLines.push(line)
    }
  }
  if (current) {
    revisions.push({
      name: current.name,
      tags: current.tags,
      card: `## ${current.name}\n${current.body.join('\n').replace(/^\n+|\n+$/g, '')}`
    })
  }
  let main = mainLines.join('\n').replace(/^\n+|\n+$/g, '')
  let mainTags: string[] = []
  const mainHeading = /^(#{1,3})\s*(?!\[修订\])(.+?)\s*$/m.exec(main)
  if (mainHeading) {
    const { title, tags } = splitHeadingHashtags(mainHeading[2])
    mainTags = tags
    if (tags.length > 0) main = main.replace(mainHeading[0], `${mainHeading[1]} ${title}`)
  }
  return { main, mainTags, revisions }
}

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
        ? `【相关已有条目（供参考并允许修订：新条目须与它们咬合不矛盾，正文中可用 [[条目名]] 引用它们。若新设定与某条已有条目矛盾或需要补充完善，可输出该条目的修订版：标题行标题必须与原条目逐字一致，正文为融合新设定后的完整内容（不得丢失原有有效信息），类型与标签按修订后内容重新标注；只能修订上面列出的条目，禁止凭空输出未列出的条目标题，无必要时不要修订）】\n${related}`
        : `【相关已有条目（仅作自洽性参考：不得重复或扩写其中内容，新条目须与之咬合不矛盾；正文中可用 [[条目名]] 引用它们）】\n${related}`)
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
    '条目之间相互引用时，在正文中使用 [[条目标题]] 链接（例如总览条目引用各个具体条目，具体条目也回链总览）。',
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

function normalizeWorldbuildParsed(
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

export function applyOutlineResult(
  p: OutlineGenParams,
  text: string
): { created: number; updated: number; skipped: number; parsed: boolean } {
  const arr = extractJsonArray(text)
  if (!arr) return { created: 0, updated: 0, skipped: 0, parsed: false }
  let created = 0
  let updated = 0
  let skipped = 0
  const existing = new Map<string, OutlineItem | null>()
  for (const o of store.listOutlines(p.projectId)) {
    const key = `${o.volume}:${o.chapterNo}`
    if (!existing.has(key)) existing.set(key, o)
  }
  for (const item of arr) {
    const r = item as Record<string, unknown>
    const volume = Number(r.volume) || p.volume
    const chapterNo = Number(r.chapter_no ?? r.chapterNo)
    if (!chapterNo || Number.isNaN(chapterNo)) continue
    const key = `${volume}:${chapterNo}`
    const hit = existing.get(key)
    const meta = {
      role: typeof r.role === 'string' ? r.role.slice(0, 40) : undefined,
      suspense: typeof r.suspense === 'string' ? r.suspense.slice(0, 20) : undefined,
      twist: Number.isFinite(Number(r.twist))
        ? Math.min(5, Math.max(0, Math.round(Number(r.twist))))
        : undefined,
      hook: typeof r.hook === 'string' ? r.hook.slice(0, 120) : undefined,
      foreshadowOps:
        typeof r.foreshadow_ops === 'string'
          ? r.foreshadow_ops.slice(0, 200)
          : typeof (r as { foreshadowOps?: unknown }).foreshadowOps === 'string'
            ? String((r as { foreshadowOps?: unknown }).foreshadowOps).slice(0, 200)
            : undefined
    }
    if (hit !== undefined) {
      if (hit && p.allowUpdate) {
        store.saveOutline({
          id: hit.id,
          projectId: p.projectId,
          volume,
          chapterNo,
          title: String(r.title ?? hit.title),
          synopsis: String(r.synopsis ?? hit.synopsis),
          status: hit.status,
          ...meta
        })
        updated++
      } else {
        skipped++
      }
      continue
    }
    store.saveOutline({
      projectId: p.projectId,
      volume,
      chapterNo,
      title: String(r.title ?? ''),
      synopsis: String(r.synopsis ?? ''),
      status: 'draft',
      ...meta
    })
    existing.set(key, null)
    created++
  }
  return { created, updated, skipped, parsed: true }
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
    ledger: Array.isArray(obj.ledger)
      ? (obj.ledger as Array<Record<string, unknown>>)
          .map((l) => ({
            name: String(l.name ?? ''),
            value: String(l.value ?? '')
          }))
          .filter((l) => l.name)
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
  enqueueEmbedding(
    projectId,
    'summary',
    outlineId,
    `第${outline.chapterNo}章 ${outline.title}：${String(obj.summary ?? '')} ${Array.isArray(obj.events) ? obj.events.join('；') : ''}`
  )

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
