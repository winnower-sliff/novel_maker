import { splitTags } from '../shared/tags'
import type {
  BuiltContext,
  ContextPart,
  OutlineItem,
  Project,
  WorldbuildEntry
} from '../shared/types'
import { semanticSearch } from './embedding'
import * as store from './store'

const CHARS_PER_TOKEN = 1 / 0.75
const TOKEN_BUDGET = 32000
const RECENT_SUMMARIES = 5
const WB_SUBGRAPH_THRESHOLD = 40
const WB_FULL_BUDGET = 8000
const WB_CLIP = 600
const PREV_TAIL_CHARS = 1200

export function estimateTokens(text: string): number {
  return Math.ceil(text.length * CHARS_PER_TOKEN)
}

function part(name: string, detail: string, text: string): ContextPart {
  return { name, detail, tokens: estimateTokens(text) }
}

function extractLinkTargets(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]/g)) {
    const name = m[1].trim()
    if (name) out.add(name)
  }
  return out
}

function renderOutlineMeta(o: OutlineItem): string {
  const lines: string[] = []
  if (o.role) lines.push(`定位：${o.role}`)
  if (o.suspense) lines.push(`悬念密度：${o.suspense}`)
  if (o.twist > 0) lines.push(`认知颠覆：${'★'.repeat(Math.min(5, o.twist))}`)
  if (o.hook) lines.push(`结尾钩子：${o.hook}`)
  if (o.foreshadowOps) lines.push(`伏笔操作：${o.foreshadowOps}`)
  return lines.join('｜')
}

function renderWorldbuildSlim(projectId: string): { text: string; detail: string } {
  const entries = store.listWorldbuild(projectId)
  if (entries.length === 0) return { text: '', detail: '无' }
  const text = entries.map((e) => `- [${e.category}] ${e.title}`).join('\n')
  return { text, detail: `${entries.length} 条（仅标题）` }
}

function renderWorldbuildFull(projectId: string): { text: string; detail: string } {
  const entries = store.listWorldbuild(projectId)
  if (entries.length === 0) return { text: '', detail: '无' }
  const text = entries
    .map((e) => {
      const tags = splitTags(e.tags)
      const tagSuffix = tags.length > 0 ? `（标签：${tags.join('、')}）` : ''
      return `### [${e.category}] ${e.title}${tagSuffix}\n${e.content}`
    })
    .join('\n\n')
  return { text, detail: `${entries.length} 条（全文）` }
}

/**
 * 相关子图选择：条目 ≥ 阈值时，从（上一章正文引用 + 本章/下一章大纲提及）构造命中集 S，
 * 并入语义检索命中，再扩展 1 跳邻居，预算内注入全文，其余降级为标题清单。
 */
async function pickWorldbuildSubgraph(
  projectId: string,
  seeds: {
    prevChapterContent: string
    currentSynopsis: string
    nextSynopsis: string
    query: string
  }
): Promise<{ text: string; detail: string } | null> {
  const entries = store.listWorldbuild(projectId)
  if (entries.length < WB_SUBGRAPH_THRESHOLD) return null

  const byTitle = new Map(entries.map((e) => [e.title.trim(), e]))
  const neighbors = new Map<string, Set<string>>()
  for (const e of entries) {
    const links = extractLinkTargets(e.content)
    const set = neighbors.get(e.id) ?? new Set<string>()
    for (const name of links) {
      const hit = byTitle.get(name)
      if (hit && hit.id !== e.id) set.add(hit.id)
    }
    neighbors.set(e.id, set)
  }

  const mentionSet = new Set<string>()
  const mentionHits = new Map<string, number>()
  for (const e of entries) {
    const candidates = [e.title.trim(), ...splitTags(e.keys)]
    let hits = 0
    for (const t of candidates) {
      if (!t || t.length < 2) continue
      if (
        seeds.prevChapterContent.includes(t) ||
        seeds.currentSynopsis.includes(t) ||
        seeds.nextSynopsis.includes(t)
      ) {
        hits++
      }
    }
    if (hits > 0) {
      mentionSet.add(e.id)
      mentionHits.set(e.id, hits)
    }
  }

  const semanticScore = new Map<string, number>()
  for (const hit of await semanticSearch(projectId, seeds.query, ['worldbuild'], 8)) {
    semanticScore.set(hit.refId, hit.score)
  }

  const degree = new Map<string, number>()
  for (const [, set] of neighbors) {
    for (const n of set) degree.set(n, (degree.get(n) ?? 0) + 1)
  }

  const selected = new Set<string>([...mentionSet, ...semanticScore.keys()])
  for (const id of [...selected]) {
    for (const n of neighbors.get(id) ?? []) selected.add(n)
  }
  if (selected.size === 0) return { text: '', detail: `${entries.length} 条（未命中相关条目）` }

  // 融合重排：提及次数(权重最高) + 语义相似度 + 图度数(弱加分)
  const fused = [...selected].map((id) => {
    const mention = mentionHits.get(id) ?? 0
    const sem = semanticScore.get(id) ?? 0
    const deg = Math.min(4, degree.get(id) ?? 0) * 0.02
    const score = mention * 0.6 + sem * 0.35 + deg
    return { id, score }
  })
  fused.sort((a, b) => b.score - a.score)

  const picked: WorldbuildEntry[] = []
  const usedIds = new Set<string>()
  let used = 0
  const byId = new Map(entries.map((e) => [e.id, e]))
  for (const { id } of fused) {
    const e = byId.get(id)
    if (!e) continue
    const cost = Math.min(WB_CLIP, e.content.length)
    if (used + cost > WB_FULL_BUDGET) continue
    picked.push(e)
    usedIds.add(id)
    used += cost
  }
  if (picked.length === 0) return { text: '', detail: `${entries.length} 条（预算内未注入）` }

  const fullText = picked
    .map((e) => {
      const tags = splitTags(e.tags)
      const tagSuffix = tags.length > 0 ? `（标签：${tags.join('、')}）` : ''
      return `### [${e.category}] ${e.title}${tagSuffix}\n${e.content.slice(0, WB_CLIP)}`
    })
    .join('\n\n')
  const restTitles = entries
    .filter((e) => !usedIds.has(e.id))
    .map((e) => `- [${e.category}] ${e.title}`)
    .join('\n')
  const text = [
    `（相关条目 ${picked.length}/${entries.length} 条全文）`,
    fullText,
    restTitles && `（其余条目标题，写作时提及须自行保持一致）\n${restTitles}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return { text, detail: `子图 ${picked.length}/${entries.length} 条全文` }
}

function renderCharactersFull(projectId: string): { text: string; detail: string } {
  const list = store.listCharacters(projectId)
  if (list.length === 0) return { text: '', detail: '无' }
  const text = list
    .map((c) => {
      const head = `### ${c.name}（${c.role || '未定位'}${c.tags ? ` · ${c.tags}` : ''}）`
      const state = c.state.trim()
      return state ? `${head}\n${c.card}\n【当前状态】\n${state}` : `${head}\n${c.card}`
    })
    .join('\n\n')
  return {
    text,
    detail: `${list.length} 卡（全文${list.some((c) => c.state.trim()) ? '含动态状态' : ''}）`
  }
}

function renderCharactersSlim(projectId: string): { text: string; detail: string } {
  const list = store.listCharacters(projectId)
  if (list.length === 0) return { text: '', detail: '无' }
  const text = list.map((c) => `- ${c.name}（${c.role || '未定位'}）`).join('\n')
  return { text, detail: `${list.length} 人（仅名单）` }
}

/**
 * 上一章结尾原文（衔接基准）：无论摘要是否存在都注入，让模型拿到真实的
 * 情绪落点与文字落点，而非只有概括。永不参与降级裁剪。
 */
function renderPrevTail(prevOutline: OutlineItem | undefined): {
  text: string
  detail: string
} {
  if (!prevOutline) return { text: '', detail: '无' }
  const chapter = store.getChapterByOutline(prevOutline.id)
  if (!chapter?.content.trim()) return { text: '', detail: '无' }
  let tail = chapter.content.slice(-PREV_TAIL_CHARS)
  if (chapter.content.length > PREV_TAIL_CHARS) {
    const nl = tail.indexOf('\n')
    if (nl > 0) tail = tail.slice(nl + 1)
  }
  return {
    text: `第${prevOutline.chapterNo}章《${prevOutline.title}》结尾节选（本章开头须直接承接此处的场景与情绪）：\n${tail}`,
    detail: `上一章末尾 ${tail.length} 字`
  }
}

function renderRecentSummaries(
  projectId: string,
  beforeOutlineId: string
): { text: string; detail: string; count: number } {
  const outlines = store.listOutlines(projectId)
  const idx = outlines.findIndex((o) => o.id === beforeOutlineId)
  if (idx <= 0) return { text: '', detail: '无', count: 0 }
  const prev = outlines.slice(Math.max(0, idx - RECENT_SUMMARIES), idx)
  const blocks: string[] = []
  let used = 0
  let ledger: string[] = []
  for (const o of [...prev].reverse()) {
    const chapter = store.getChapterByOutline(o.id)
    if (!chapter) continue
    const s = store.getSummary(chapter.id)
    if (!s) continue
    blocks.push(
      [
        `第${o.chapterNo}章（${o.title}）：${s.summary}`,
        s.timeline ? `时间线：${s.timeline}` : '',
        s.characterStates.length > 0
          ? `人物状态：${s.characterStates.map((cs) => `${cs.name}=${cs.state}`).join('；')}`
          : ''
      ]
        .filter(Boolean)
        .join('\n')
    )
    if (ledger.length === 0 && s.ledger.length > 0) {
      ledger = s.ledger.map((l) => `${l.name}=${l.value}`)
    }
    used++
  }
  if (blocks.length === 0) return { text: '', detail: '无', count: 0 }
  const text =
    ledger.length > 0
      ? `${blocks.join('\n\n')}\n\n【硬账台账（上一章末，数字必须衔接）】\n${ledger.join('；')}`
      : blocks.join('\n\n')
  return {
    text,
    detail: `最近 ${used} 章摘要${ledger.length > 0 ? '（含硬账）' : ''}`,
    count: used
  }
}

function renderVolumeSummaries(
  projectId: string,
  currentVolume: number
): { text: string; detail: string } {
  const all = store.listVolumeSummaries(projectId).filter((v) => v.volume < currentVolume)
  if (all.length === 0) return { text: '', detail: '无' }
  const text = all.map((v) => `【第 ${v.volume} 卷摘要】\n${v.summary}`).join('\n\n')
  return { text, detail: `前 ${all.length} 卷` }
}

function renderForeshadows(projectId: string): { text: string; detail: string } {
  const open = store.listForeshadows(projectId).filter((f) => f.status === 'open')
  if (open.length === 0) return { text: '', detail: '无' }
  // 分层：主线/人物级全量注入；氛围级仅计数——重复登记的钩子多为氛围级，全量注入会淹没主线
  const major = open.filter((f) => f.priority.trim() !== '氛围')
  const ambienceCount = open.length - major.length
  const text = major
    .map((f) => {
      const extras: string[] = []
      if (f.priority) extras.push(f.priority)
      if (f.plannedResolve) extras.push(`计划回收：${f.plannedResolve}`)
      const suffix = extras.length > 0 ? `（${extras.join('，')}）` : ''
      return `- ${f.content}${suffix}（埋于${f.plantedChapter || '?'}）`
    })
    .join('\n')
  const note =
    ambienceCount > 0 ? `\n（另有 ${ambienceCount} 条氛围级伏笔，无需在正文刻意回应）` : ''
  const count =
    ambienceCount > 0
      ? `${major.length} 条未回收（另 ${ambienceCount} 条氛围级）`
      : `${major.length} 条未回收`
  return { text: text + note, detail: count }
}

/**
 * 开篇章的故事起点（链表头节点无 prev，靠 next 向数据入戏）：
 * premise 草稿（仅第一卷）+ 本卷创意，来自创作向导存档 projects.wizard_plan。
 * 数据缺失（向导完成后清空/旧项目）时静默降级为空。
 */
interface WizardPlanShape {
  draftText?: string
  volumePlans?: Record<string, { idea?: string }>
}

function renderStoryOrigin(project: Project, volume: number): { text: string; detail: string } {
  let plan: WizardPlanShape | null = null
  try {
    plan = project.wizardPlan ? (JSON.parse(project.wizardPlan) as WizardPlanShape) : null
  } catch {
    plan = null
  }
  const idea = plan?.volumePlans?.[String(volume)]?.idea?.trim() ?? ''
  const premise = volume === 1 ? (plan?.draftText?.trim() ?? '') : ''
  if (!premise && !idea) return { text: '', detail: '无' }
  const text = [premise && `【作品 premise】\n${premise}`, idea && `【本卷核心创意】\n${idea}`]
    .filter(Boolean)
    .join('\n\n')
  return { text, detail: `开篇故事起点（premise ${premise.length} 字 / 卷创意 ${idea.length} 字）` }
}

export async function buildChapterContext(
  projectId: string,
  outlineId: string,
  wordTarget?: number
): Promise<BuiltContext> {
  const project = store.listProjects().find((p) => p.id === projectId)
  const outlines = store.listOutlines(projectId)
  const idx = outlines.findIndex((o) => o.id === outlineId)
  if (!project || idx < 0) throw new Error('章节不存在')

  const current = outlines[idx]
  const prev = outlines[idx - 1]
  const next = outlines[idx + 1]

  const styleText = project.styleGuide
  const summaries = renderRecentSummaries(projectId, outlineId)
  const volumeSummaries = renderVolumeSummaries(projectId, current.volume)
  const foreshadows = renderForeshadows(projectId)

  const prevChapter = prev ? store.getChapterByOutline(prev.id) : null
  const prevChapterContent = prevChapter ? prevChapter.content : ''
  const prevTail = renderPrevTail(prev)
  const origin = prev ? { text: '', detail: '无' } : renderStoryOrigin(project, current.volume)

  const scenesText =
    current.scenes.length > 0
      ? `场景序列（按本章顺序展开）：\n${current.scenes.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : ''
  const nextScenesText =
    next && next.scenes.length > 0
      ? `\n下一章场景序列（结尾钩子须顺势滑入）：\n${next.scenes.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : ''

  const outlineText = [
    prev ? `上一章（第${prev.chapterNo}章 ${prev.title}）梗概：${prev.synopsis}` : '本章为开篇',
    `本章：第${current.chapterNo}章 ${current.title}\n梗概：${current.synopsis}${renderOutlineMeta(current) ? `\n${renderOutlineMeta(current)}` : ''}`,
    scenesText,
    next
      ? `下一章预告（第${next.chapterNo}章 ${next.title}）：${next.synopsis}${renderOutlineMeta(next) ? `\n${renderOutlineMeta(next)}` : ''}${nextScenesText}`
      : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  const subgraph = await pickWorldbuildSubgraph(projectId, {
    prevChapterContent,
    currentSynopsis: `${current.title} ${current.synopsis}`,
    nextSynopsis: next ? `${next.title} ${next.synopsis}` : '',
    query: `第${current.chapterNo}章 ${current.title}。${current.synopsis} ${current.hook ?? ''}`
  })
  let wb = subgraph ?? renderWorldbuildFull(projectId)
  let ch = renderCharactersFull(projectId)

  const estimate = (extra: number): number =>
    estimateTokens(styleText) +
    estimateTokens(wb.text) +
    estimateTokens(ch.text) +
    estimateTokens(summaries.text) +
    estimateTokens(volumeSummaries.text) +
    estimateTokens(foreshadows.text) +
    estimateTokens(prevTail.text) +
    estimateTokens(origin.text) +
    estimateTokens(outlineText) +
    extra

  const instructionLen = 300
  if (estimate(instructionLen) > TOKEN_BUDGET) {
    ch = renderCharactersSlim(projectId)
  }
  if (estimate(instructionLen) > TOKEN_BUDGET) {
    wb = renderWorldbuildSlim(projectId)
  }

  const sections: Array<[string, string]> = (
    [
      ['【作品风格】', styleText],
      ['【故事起点（开篇基准）】', origin.text],
      ['【前卷摘要（远期前情）】', volumeSummaries.text],
      ['【世界观设定】', wb.text],
      ['【人物卡（含动态状态）】', ch.text],
      ['【前情摘要】', summaries.text],
      ['【伏笔台账（未回收）】', foreshadows.text],
      ['【上一章结尾（衔接基准）】', prevTail.text],
      ['【本章大纲】', outlineText]
    ] as Array<[string, string]>
  ).filter(([, text]) => text.trim().length > 0)

  const system = sections.map(([head, text]) => `${head}\n${text}`).join('\n\n')
  const words = wordTarget && wordTarget > 0 ? wordTarget : 2700
  const seamOpen = prevTail.text.trim()
    ? '开头必须直接承接【上一章结尾（衔接基准）】的场景、情绪与时空，禁止时间跳跃、场景切换或另起炉灶式开场'
    : origin.text.trim()
      ? '本章为开篇：开头须从【故事起点（开篇基准）】自然入戏，直接进入本章大纲的第一个场景（建立主角处境与核心冲突）；禁止天气开场、背景倾倒或概述式开头'
      : ''
  const seamClose = next ? '结尾钩子必须顺势滑入【下一章预告】的开场场景' : ''
  const seam = [seamOpen, seamClose].filter(Boolean).join('；')
  const user = [
    `请撰写本章正文，目标 ${words} 字（浮动 ±20%）。`,
    seam && `衔接要求：${seam}。`,
    '直接输出正文，可带章节标题。'
  ]
    .filter(Boolean)
    .join('')

  const parts = [
    part('风格指南', project.styleGuide ? '已配置' : '无', styleText),
    part('故事起点', origin.detail, origin.text),
    part('卷摘要', volumeSummaries.detail, volumeSummaries.text),
    part('世界观', wb.detail, wb.text),
    part('人物', ch.detail, ch.text),
    part('前情', summaries.detail, summaries.text),
    part('伏笔', foreshadows.detail, foreshadows.text),
    part('上一章结尾', prevTail.detail, prevTail.text),
    part('大纲', `当前+前后章${renderOutlineMeta(current) ? '（含元数据）' : ''}`, outlineText)
  ]

  return {
    system,
    user,
    parts,
    totalTokens: parts.reduce((a, p) => a + p.tokens, 0)
  }
}
