import type {
  AlignRevision,
  ChatParams,
  Foreshadow,
  OutlineGenParams,
  OutlineItem,
  PremiseDraftResult
} from '../../shared/types'
import { enqueueEmbedding } from '../embedding'
import * as store from '../store'
import { buildForeLedger, FORE_PRIORITIES, FORE_REF_RE, normalizeForeText } from './fore'
import { clampInt, extractJsonArray, extractJsonObject, skillBody } from './util'

/** 大纲/卷创意共用的项目素材拼装（每次现查库，量级小）；卷创意为纯文本输出，伏笔台账用无编号形态 */
function collectOutlineMaterials(projectId: string, volume: number, numberedFore = true) {
  const project = store.listProjects().find((x) => x.id === projectId)
  const wb = store
    .listWorldbuild(projectId)
    .map((e) => `- [${e.category}] ${e.title}：${e.content.slice(0, 200)}`)
    .join('\n')
  const chars = store
    .listCharacters(projectId)
    .map((c) => `- ${c.name}（${c.role || '未定位'}）：${c.card.slice(0, 200)}`)
    .join('\n')
  const outlineCtx = store
    .listOutlines(projectId)
    .filter((o) => o.volume === volume)
    .sort((a, b) => a.chapterNo - b.chapterNo)
    .map((o) => `- 第${o.chapterNo}章《${o.title}》：${o.synopsis.slice(0, 200)}`)
    .join('\n')
  // 分层编号台账：主/人物级全量、氛围级节选，防伏笔累积撑爆 prompt
  const openFore = buildForeLedger(projectId, numberedFore).text
  return { project, wb, chars, outlineCtx, openFore }
}

/** 分批生成时本批的范围与衔接上下文 */
export interface OutlineBatch {
  start: number
  count: number
  total: number
  totalStart: number
  prevTail?: string
}

/** 规则块文案：通用/本卷分开标注，共用逐章严格执行要求 */
function rulesBlock(kind: '通用规则' | '本卷规则', text: string, p: OutlineGenParams): string {
  const scope = kind === '通用规则' ? '全书各卷适用' : `仅第 ${p.volume} 卷适用`
  return `【${kind}（用户制定，${scope}，逐章严格执行，优先级高于下方结构原则与核心创意；每条规则须映射到具体章号，并把规则要求的剧情写成该章 scenes 中的具体场景，禁止只在 synopsis 点名；规则中的绝对章号若超出本次生成范围（第 ${p.startNo}~${p.startNo + p.count - 1} 章），将其要求顺延或并入范围内相近章节执行，不得因超出范围而整体忽略）】\n${text}`
}

export function outlineUserPrompt(p: OutlineGenParams, b: OutlineBatch | null): string {
  const idea = `核心创意：${p.idea}`
  const scope = b
    ? `本次生成第 ${p.volume} 卷、第 ${b.start} 章至第 ${b.start + b.count - 1} 章的大纲（本批共 ${b.count} 章；全卷计划生成第 ${b.totalStart} 章至第 ${b.totalStart + b.total - 1} 章共 ${b.total} 章，分批生成中，后续批次将自动续写）。严格按约定的 JSON 数组格式只输出本批章节，不要输出其他内容。`
    : `请生成第 ${p.volume} 卷、第 ${p.startNo} 章到第 ${p.startNo + p.count - 1} 章的大纲（共 ${p.count} 章），严格按约定的 JSON 数组格式输出，不要输出其他内容。`
  const hasRules = !!(p.rules?.trim() || p.globalRules?.trim())
  const rulesNote = hasRules
    ? '\n硬性节奏规则区中的每一条都必须落实到具体章节，不得省略或合并；规则要求的剧情必须写成对应章 scenes 里的具体场景，禁止只在 synopsis 点名。'
    : ''
  const tailNote = b?.prevTail
    ? `\n\n【已生成的前文（本批须自然衔接，不得重复已有章节）】\n${b.prevTail}`
    : ''
  return `${idea}\n\n${scope}${rulesNote}${tailNote}`
}

/** 从已生成的全文中提取衔接上下文：全部章节标题 + 末 2 章梗概 */
export function outlineBatchTail(fullText: string): string {
  const arr = extractJsonArray(fullText)
  if (!arr || arr.length === 0) return ''
  const items = arr as Array<Record<string, unknown>>
  const titles = items
    .map((o) => `第${o.chapter_no ?? o.chapterNo}章《${o.title ?? ''}》`)
    .join('、')
  const tail = items
    .slice(-2)
    .map(
      (o) =>
        `第${o.chapter_no ?? o.chapterNo}章《${o.title ?? ''}》：${String(o.synopsis ?? '').slice(0, 200)}`
    )
    .join('\n')
  return `已生成章节：${titles}\n末尾章节梗概：\n${tail}`
}

export function buildOutlineRequest(p: OutlineGenParams, batch?: OutlineBatch): ChatParams {
  const { project, wb, chars, outlineCtx, openFore } = collectOutlineMaterials(
    p.projectId,
    p.volume
  )
  const system = [
    skillBody('outline-architect'),
    project?.styleGuide && `【作品风格】\n${project.styleGuide}`,
    wb && `【已有世界观】\n${wb}`,
    chars && `【已有人物】\n${chars}`,
    openFore &&
      `【未回收伏笔台账（编号稳定；主线/人物级全量，氛围级仅节选）。为需要回收或升级的伏笔安排回收章：在对应章节对象中输出 foreshadow_plan:[{"ref":"编号","priority":"主线|人物|氛围"}]（priority 可省略表示仅定回收点不调级），系统会据此更新台账；氛围级节选条目无需逐条处理】\n${openFore}`,
    p.globalRules?.trim() && rulesBlock('通用规则', p.globalRules.trim(), p),
    p.rules?.trim() && rulesBlock('本卷规则', p.rules.trim(), p),
    // 覆盖重写（allowUpdate:true）刻意不注入旧大纲：整卷重写时旧标题/梗概只会牵引 AI 复刻旧框架，
    // 用户预期是按新创意另起；仅非覆盖模式（同章号跳过语义）需要旧大纲做衔接参考
    outlineCtx &&
      !p.allowUpdate &&
      `【第 ${p.volume} 卷已有大纲（新章节须与之自然衔接；已存在的同章号章节会被跳过，不会重复生成）】\n${outlineCtx}`
  ]
    .filter(Boolean)
    .join('\n\n')
  const user = outlineUserPrompt(p, batch ?? null)
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: batch
      ? Math.max(16384, batch.count * 2000)
      : Math.min(65536, Math.max(16384, p.count * 2000)),
    temperature: 0.7,
    purpose: 'outline'
  }
}

/** 卷创意起草：把用户的简短要求扩写成正式的本卷创意（纯文字，供 idea 框修改后再生成大纲） */
export function buildVolumeIdeaRequest(
  projectId: string,
  volume: number,
  idea: string,
  rulesText?: string,
  globalRulesText?: string
): ChatParams {
  const req = idea.trim()
  if (!req) throw new Error('请先在创意框写下你对这一卷的要求')
  // 刻意不注入本卷已有大纲：idea 可持久化（volumePlans），起草创意时应忠于用户要求而非被旧大纲牵引
  const { project, wb, chars, openFore } = collectOutlineMaterials(projectId, volume, false)
  const volSums = store
    .listVolumeSummaries(projectId)
    .sort((a, b) => a.volume - b.volume)
    .map((v) => `【第${v.volume}卷完成摘要】${v.summary.slice(0, 600)}`)
    .join('\n\n')
  const rules = rulesText?.trim()
  const globalRules = globalRulesText?.trim()
  const system = [
    '你是小说项目的卷策划。基于已有设定与前情，把用户的本卷要求扩写成一份可直接执行的卷创意。只输出自然段纯文字，不要标题、编号列表、JSON 或任何解释。',
    '卷创意要求（3-5 个自然段，共 400-600 字）：把本卷划分成 3-5 个软边界的情节单元，每段写清该段的小目标、核心冲突与阶段成果，段与段之间渐进过渡、允许情节交织；每段开头用自然语言短语点明所在位置（如「开篇章（卷首）：」「中段：」「收束章（卷末）：」），只用相对位置（卷首、前三分之一、中段、卷末等）描述段界，禁止写死章号；整体须写清承接前情的起点、本卷主线冲突与阶段推进、关键人物的作用、本卷收束点与引向下卷的钩子；必须与已有世界观、人物关系咬合，合理安排未回收伏笔的回收或推进。',
    globalRules &&
      `【用户的通用规则（全书各卷适用；创意叙事必须与这些规则兼容，但不要在创意正文里复述规则本身）】\n${globalRules}`,
    rules &&
      `【用户的本卷硬性节奏规则（创意叙事必须与这些规则兼容，但不要在创意正文里复述规则本身）】\n${rules}`,
    project?.styleGuide && `【作品风格】\n${project.styleGuide}`,
    wb && `【已有世界观】\n${wb}`,
    chars && `【已有人物】\n${chars}`,
    volSums && `【已完成各卷前情摘要】\n${volSums}`,
    openFore && `【未回收伏笔台账】\n${openFore}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: `本卷要求：${req}\n\n请输出第 ${volume} 卷的卷创意。` }],
    maxTokens: 4096,
    temperature: 0.8,
    purpose: 'outline'
  }
}

/** 规则优化：把用户粗糙的节奏/硬性要求改写成详实可执行的规则清单（纯文本多行，用户确认后回填） */
export function buildRulesRefineRequest(
  projectId: string,
  volume: number,
  rules: string,
  globalRulesText?: string
): ChatParams {
  const raw = rules.trim()
  if (!raw) throw new Error('请先在规则框写下你的要求')
  const { project, wb, chars } = collectOutlineMaterials(projectId, volume)
  const outlineCtx = store
    .listOutlines(projectId)
    .filter((o) => o.volume === volume)
    .sort((a, b) => a.chapterNo - b.chapterNo)
    .map((o) => `- 第${o.chapterNo}章《${o.title}》`)
    .join('\n')
  const system = [
    '你是网文大纲的节奏策划。把用户粗糙的「节奏与硬性要求」改写成一份详实、无歧义、可直接逐章执行的规则清单。',
    '输出格式：只输出规则清单本身，每行一条规则，不要编号以外的解释、不要 JSON、不要总结。',
    '改写要求：',
    '- 保留用户每条规则的原意与量化区间（如「每 3~6 章」不得改成固定值）；节奏表述一律用相对频率或相对位置（如「卷内每 10 章一个小故事」「卷末 3 章内收束」「卷长 1/3 处转折」），禁止自行编造绝对章号——优化规则时卷的总章数尚未确定，写死章号会与实际生成章数失配；用户原始规则中明确写了章号的，原样保留；',
    '- 每条规则写清：触发节奏（相对频率/相对区间，禁止编造绝对章号）、内容要求、篇幅占比或呈现方式、与其他规则的优先级关系；',
    '- 规则之间冲突时按用户书写顺序取舍并在该条末尾注明；可补 1-2 条使节奏更张弛有度的建议规则（标注「建议」）；',
    '- 禁止删除或合并用户规则。'
  ]
    .filter(Boolean)
    .join('\n')
  const user = [
    `【第 ${volume} 卷上下文（用于让规则贴合实际，不得改变规则原意）】`,
    project?.styleGuide && `风格：${project.styleGuide.slice(0, 200)}`,
    wb && `世界观条目：\n${wb.slice(0, 800)}`,
    chars && `人物：\n${chars.slice(0, 500)}`,
    outlineCtx && `本卷已有大纲章节：\n${outlineCtx}`,
    globalRulesText?.trim() &&
      `通用规则（全书各卷适用，优化结果须与之兼容、不得冲突）：\n${globalRulesText.trim()}`,
    '',
    `【用户的原始规则】\n${raw}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 2048,
    temperature: 0.4,
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

/**
 * 解析章级 foreshadow_plan：只校验与去重，返回引用到的伏笔 id 及可选优先级；
 * planned_resolve 的文本与 uid 落库在 outline 行确定后统一执行（见 applyPlannedResolve）。
 */
function parseForePlanItems(
  plan: unknown,
  foreMapping: Map<string, string>,
  foreById: Map<string, Foreshadow>,
  seen: Set<string>
): Array<{ id: string; priority: string }> {
  if (!Array.isArray(plan)) return []
  const items: Array<{ id: string; priority: string }> = []
  for (const item of plan) {
    const r = (item ?? {}) as Record<string, unknown>
    const ref = String(r.ref ?? '')
      .trim()
      .toUpperCase()
    if (!FORE_REF_RE.test(ref)) continue
    const id = foreMapping.get(ref)
    const target = id ? foreById.get(id) : undefined
    if (target?.status !== 'open' || seen.has(target.id)) continue
    seen.add(target.id)
    items.push({ id: target.id, priority: typeof r.priority === 'string' ? r.priority.trim() : '' })
  }
  return items
}

/** outline 行落库后回填计划回收点：uid 为结构事实，文本仅作悬空回退展示 */
function applyPlannedResolve(
  items: Array<{ id: string; priority: string }>,
  outline: OutlineItem,
  projectId: string,
  foreById: Map<string, Foreshadow>
): number {
  for (const it of items) {
    const target = foreById.get(it.id)
    if (!target) continue
    store.saveForeshadow({
      id: it.id,
      projectId,
      content: target.content,
      plannedResolve: `第${outline.chapterNo}章`,
      plannedResolveOutlineId: outline.id,
      priority: FORE_PRIORITIES.find((x) => x === it.priority)
    })
  }
  return items.length
}

export function applyOutlineResult(
  p: OutlineGenParams,
  text: string
): { created: number; updated: number; skipped: number; parsed: boolean; forePlans: number } {
  const arr = extractJsonArray(text)
  if (!arr) return { created: 0, updated: 0, skipped: 0, parsed: false, forePlans: 0 }
  let created = 0
  let updated = 0
  let skipped = 0
  let forePlans = 0
  const foreMapping = buildForeLedger(p.projectId, true).mapping
  const foreById = new Map(store.listForeshadows(p.projectId).map((f) => [f.id, f]))
  const plannedFores = new Set<string>()
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
    const planFores = parseForePlanItems(r.foreshadow_plan, foreMapping, foreById, plannedFores)
    const key = `${volume}:${chapterNo}`
    const hit = existing.get(key)
    const meta = {
      scenes: Array.isArray(r.scenes)
        ? (r.scenes as unknown[])
            .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
            .map((s) => s.trim().slice(0, 120))
            .slice(0, 6)
        : undefined,
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
        const saved = store.saveOutline({
          id: hit.id,
          projectId: p.projectId,
          volume,
          chapterNo,
          title: String(r.title ?? hit.title),
          synopsis: String(r.synopsis ?? hit.synopsis),
          status: hit.status,
          ...meta
        })
        forePlans += applyPlannedResolve(planFores, saved, p.projectId, foreById)
        updated++
      } else {
        // 跳过落库也要应用伏笔计划（与旧行为对齐）；hit 为 null 表示同批次键重复，计划已随首个条目应用
        if (hit) forePlans += applyPlannedResolve(planFores, hit, p.projectId, foreById)
        skipped++
      }
      continue
    }
    const saved = store.saveOutline({
      projectId: p.projectId,
      volume,
      chapterNo,
      title: String(r.title ?? ''),
      synopsis: String(r.synopsis ?? ''),
      status: 'draft',
      ...meta
    })
    forePlans += applyPlannedResolve(planFores, saved, p.projectId, foreById)
    existing.set(key, null)
    created++
  }
  return { created, updated, skipped, parsed: true, forePlans }
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

  const allFore = store.listForeshadows(projectId)
  const foreById = new Map(allFore.map((f) => [f.id, f]))
  const foreMapping = buildForeLedger(projectId, true).mapping
  const existingOpen = allFore.filter((f) => f.status === 'open')
  // 存档去编号化：编号是 build 时刻快照，翻译回内容文本保证 summary 存档自描述
  const resolveArchiveText = (raw: string): string => {
    const ref = raw.trim().toUpperCase()
    if (FORE_REF_RE.test(ref)) {
      const id = foreMapping.get(ref)
      const f = id ? foreById.get(id) : undefined
      if (f) return f.content
    }
    return raw
  }

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
      ? obj.foreshadows_resolved.map((x) => resolveArchiveText(String(x)))
      : []
  })
  enqueueEmbedding(
    projectId,
    'summary',
    outlineId,
    `第${outline.chapterNo}章 ${outline.title}：${String(obj.summary ?? '')} ${Array.isArray(obj.events) ? obj.events.join('；') : ''}`
  )

  // 代码兜底上限：AI 摘要偶发过量登记（曾致单项目累积 1300+ open），每章登记/回收各最多 3 条
  const FORE_PER_CHAPTER_LIMIT = 3
  let plantedCount = 0
  for (const f of Array.isArray(obj.foreshadows_planted)
    ? (obj.foreshadows_planted as Array<Record<string, unknown>>)
    : []) {
    if (plantedCount >= FORE_PER_CHAPTER_LIMIT) break
    const content = String(f.content ?? '').trim()
    const normalized = normalizeForeText(content)
    if (!content || !normalized) continue
    // 去重双保险：LLM 已对照注入台账，这里再做归一化等值兜底（宁漏勿误）
    if (
      existingOpen.some((x) => x.content === content || normalizeForeText(x.content) === normalized)
    )
      continue
    const priority = String(f.priority ?? '').trim()
    store.saveForeshadow({
      projectId,
      content,
      plantedChapter: `第${outline.chapterNo}章`,
      plantedOutlineId: outline.id,
      status: 'open',
      priority: FORE_PRIORITIES.find((x) => x === priority) ?? ''
    })
    plantedCount++
  }

  let resolvedCount = 0
  const resolvedSeen = new Set<string>()
  const resolvedList = Array.isArray(obj.foreshadows_resolved)
    ? obj.foreshadows_resolved.map(String)
    : []
  for (const raw of resolvedList) {
    if (resolvedCount >= FORE_PER_CHAPTER_LIMIT) break
    const ref = raw.trim().toUpperCase()
    let target: Foreshadow | undefined
    if (FORE_REF_RE.test(ref)) {
      const id = foreMapping.get(ref)
      if (id) target = foreById.get(id)
    }
    // 兜底：编号失配或旧格式自由文本走子串匹配
    if (!target) {
      target = existingOpen.find((x) => raw.includes(x.content) || x.content.includes(raw))
    }
    if (target && target.status === 'open' && !resolvedSeen.has(target.id)) {
      store.saveForeshadow({
        id: target.id,
        projectId,
        content: target.content,
        plantedChapter: target.plantedChapter,
        status: 'resolved',
        resolvedChapter: `第${outline.chapterNo}章`,
        resolvedOutlineId: outline.id
      })
      resolvedSeen.add(target.id)
      resolvedCount++
    }
  }

  return { planted: plantedCount, resolved: resolvedCount, parsed: true }
}

const ALIGN_SYSTEM = [
  '你是小说项目的连续性编辑。给定「已写章节的实际剧情」与「后续未写章节的大纲梗概」，检查后续大纲是否与已写剧情脱节（人物状态不符、伏笔悬空、情节矛盾、节奏断裂），仅对需要修订的章节输出修订条目。',
  '严格输出 JSON 数组，不要 markdown 代码块、不要解释文字：',
  '[{"chapter_no":9,"synopsis":"修订后的完整章节梗概（一句话纯剧情概要，50字内，禁止背景解说/前情回顾/解说腔）","scenes":["修订后的场景序列（可选，2-4条「人物+动作/冲突」场景句；该章剧情因修订而变化时才给出，省略则保留原场景）"],"hook":"结尾钩子（可选）","reason":"修订原因一句话"}]',
  '要求：',
  '- 只输出确实需要修订的章节；与已写剧情衔接良好的章节不要输出',
  '- synopsis 必须是修订后的完整梗概（不是增量说明），并与前后章自然衔接',
  '- 若全部无需修订，输出 []',
  '- JSON 字符串内不得出现未转义的引号或换行'
].join('\n')

export function buildAlignRequest(projectId: string): ChatParams {
  const outlines = store.listOutlines(projectId).sort((a, b) => a.chapterNo - b.chapterNo)
  const written: string[] = []
  const pending: string[] = []
  for (const o of outlines) {
    const chapter = store.getChapterByOutline(o.id)
    if (chapter) {
      const s = store.getSummary(chapter.id)
      written.push(`第${o.chapterNo}章《${o.title}》：${s?.summary?.slice(0, 300) || '（无摘要）'}`)
    } else {
      pending.push(
        `第${o.chapterNo}章《${o.title}》：${o.synopsis.slice(0, 200)}${o.hook ? `（钩子：${o.hook}）` : ''}`
      )
    }
  }
  if (written.length === 0) throw new Error('还没有已写作的章节，无需对齐')
  if (pending.length === 0) throw new Error('没有未写作的大纲章节，无需对齐')
  const vols = store.listVolumeSummaries(projectId)
  const system = [
    ALIGN_SYSTEM,
    vols.length > 0 &&
      `【各卷剧情摘要】\n${vols.map((v) => `第${v.volume}卷：${v.summary.slice(0, 500)}`).join('\n')}`
  ]
    .filter(Boolean)
    .join('\n\n')
  // 已写章节只取最近 30 章，防止超长
  const user = `【已写章节实际剧情（最近 ${Math.min(30, written.length)} 章）】\n${written.slice(-30).join('\n')}\n\n【后续未写章节大纲（共 ${pending.length} 章）】\n${pending.join('\n')}\n\n请检查后续大纲与已写剧情的连贯性，输出需修订章节的 JSON 数组。`
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 8192,
    temperature: 0.4,
    purpose: 'outline'
  }
}

export function parseAlignResult(
  projectId: string,
  text: string
): { parsed: boolean; revisions: AlignRevision[] } {
  const arr = extractJsonArray(text)
  if (!arr) return { parsed: false, revisions: [] }
  const byKey = new Map<string, OutlineItem>()
  for (const o of store.listOutlines(projectId)) byKey.set(`${o.volume}:${o.chapterNo}`, o)
  const revisions: AlignRevision[] = []
  for (const item of arr) {
    const r = item as Record<string, unknown>
    const chapterNo = Number(r.chapter_no ?? r.chapterNo)
    const synopsis = String(r.synopsis ?? '').trim()
    if (!chapterNo || Number.isNaN(chapterNo) || !synopsis) continue
    // 未指定卷时在全部卷中找同章号且未写的章节
    const hit =
      byKey.get(`1:${chapterNo}`) ??
      [...byKey.values()].find((o) => o.chapterNo === chapterNo && !store.getChapterByOutline(o.id))
    if (!hit) continue
    revisions.push({
      outlineId: hit.id,
      volume: hit.volume,
      chapterNo: hit.chapterNo,
      title: hit.title,
      synopsis: synopsis.slice(0, 1000),
      scenes: Array.isArray(r.scenes)
        ? (r.scenes as unknown[])
            .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
            .map((s) => s.trim().slice(0, 120))
            .slice(0, 6)
        : undefined,
      hook: typeof r.hook === 'string' ? r.hook.slice(0, 120) : undefined,
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 200) : undefined
    })
  }
  return { parsed: true, revisions }
}
