import type {
  ChatParams,
  OutlineGenParams,
  OutlineItem,
  PremiseDraftResult
} from '../../shared/types'
import { enqueueEmbedding } from '../embedding'
import * as store from '../store'
import { clampInt, extractJsonArray, extractJsonObject, skillBody } from './util'

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
