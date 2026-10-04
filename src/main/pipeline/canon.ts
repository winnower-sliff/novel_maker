// canonSync：大纲生成导入后的「设定回写」闭环——
// 对照新卷大纲与已有世界观/人物，输出新世界观条目（预览确认）、
// 已有条目修订建议（预览确认）与新人物完整卡（自动落库）。
import { splitTags } from '../../shared/tags'
import type { CanonWorldUpdate, ChatParams, WorldbuildPreviewEntry } from '../../shared/types'
import * as store from '../store'
import { parseCharacterCards, renderCharacterCards } from './character'
import { normalizeWorldbuildParsed, parseWorldbuildEntries } from './worldbuild'

type ParsedCharacterCards = ReturnType<typeof parseCharacterCards>

const WB_CLIP = 500
const WB_BUDGET = 8000
const CHAR_CLIP = 600

export function buildCanonSyncRequest(projectId: string, volume: number): ChatParams {
  const volOutlines = store
    .listOutlines(projectId)
    .filter((o) => o.volume === volume)
    .sort((a, b) => a.chapterNo - b.chapterNo)
  if (volOutlines.length === 0) throw new Error(`第 ${volume} 卷没有大纲，无需同步设定`)
  const outlineLines = volOutlines
    .map((o) => `- 第${o.chapterNo}章《${o.title}》：${o.synopsis}`)
    .join('\n')

  // 已有世界观：全文有预算地注入（修订建议需要原文对照）
  const entries = store.listWorldbuild(projectId)
  const entryBlocks: string[] = []
  let used = 0
  for (const e of entries) {
    const body = e.content.slice(0, WB_CLIP)
    const cost = body.length
    if (used + cost > WB_BUDGET && entryBlocks.length > 0) break
    entryBlocks.push(
      `### [${e.category}] ${e.title}${splitTags(e.tags).length > 0 ? ` #${splitTags(e.tags).join(' #')}` : ''}\n${body}`
    )
    used += cost
  }
  const wbBlock =
    entryBlocks.length > 0 ? entryBlocks.join('\n\n') : '（暂无世界观条目——请全部作为新增输出）'

  const chars = store.listCharacters(projectId)
  const charBlock =
    chars.length > 0
      ? renderCharacterCards(chars, CHAR_CLIP)
      : '（暂无人物——新人物按完整人物卡输出）'

  const system = [
    '你是小说设定的守护者。任务：对照一卷新写好的章节大纲，检查已有世界观与人物班底，',
    '把大纲中出现但设定库还没有的新事物补成条目/人物，把与新大纲冲突或明显需要补充的已有条目给出修订版。',
    '世界观条目宁缺毋滥——只补大纲明确依赖、不补就会造成设定空洞的内容；纯氛围性一次性事物不要建档；',
    '但人物必须全覆盖：凡在大纲里出场（或被剧情明确依赖）而【已有人物班底】中没有的人物，',
    '每一个都必须输出完整人物卡，禁止省略、禁止合并，哪怕戏份很少也要建档（可在卡内注明戏份定位）；',
    '修订条目必须保留原文全部有效信息，只融合新设定；新人物的定位必须与已有人物咬合、避免重复。',
    '类型只能用已有条目中出现过的类型；标签优先复用已有标签。'
  ].join('')

  const user = [
    `【第 ${volume} 卷章节大纲（共 ${volOutlines.length} 章）】`,
    outlineLines,
    '',
    '【已有世界观条目】',
    wbBlock,
    '',
    '【已有人物班底】',
    charBlock,
    '',
    '输出格式（严格遵守，除此之外不要输出任何内容）：',
    '依次输出以下三个段落；某段落没有内容时整段省略；全部为空时只输出：无',
    '',
    '【世界观新增】',
    '## [类型] 标题 #标签1 #标签2',
    '（markdown 要点式正文，2-4 个要点共 50-150 字，至少 2 个 [[条目标题]] 交叉链接）',
    '',
    '【世界观修订】',
    '## 原条目标题',
    '（融合新设定后的完整修订正文，标题必须与已有条目逐字一致）',
    '',
    '【新增人物】',
    '## 人物名（一句话定位） #标签1 #标签2',
    '（硬性要求：先逐一核对本卷大纲全部章节里出现的每个人名，凡不在【已有人物班底】清单中的，',
    '每个都必须单独输出一张完整人物卡，一个都不能漏；定位必须写在标题行名字后的括号里，',
    '随后为 markdown 要点式正文；',
    '如需调整已有人物，用「## [修订] 原人物名」标题行追加修订卡）'
  ].join('\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 16384,
    temperature: 0.5,
    purpose: 'outline'
  }
}

export interface ParsedCanonSync {
  worldNew: WorldbuildPreviewEntry[]
  worldUpdates: CanonWorldUpdate[]
  characters: ParsedCharacterCards | null
  /** 主卡「定位：」首行提取（落库写 role，卡内不留该行） */
  mainRole?: string
}

/** 解析三段式输出；修订条目按标题匹配原条目（匹配不到的丢弃），人物卡交调用方落库 */
export function parseCanonSyncResult(projectId: string, text: string): ParsedCanonSync {
  const trimmed = text.trim()
  if (!trimmed || /^无$/.test(trimmed)) {
    return { worldNew: [], worldUpdates: [], characters: null }
  }
  const seg = (name: string): string => {
    const re = new RegExp(`^【${name}】\\s*$`, 'm')
    const m = re.exec(trimmed)
    if (!m) return ''
    const start = m.index + m[0].length
    const next = ['世界观新增', '世界观修订', '新增人物']
      .map((n) => {
        const mm = new RegExp(`^【${n}】\\s*$`, 'm').exec(trimmed.slice(start))
        return mm ? start + mm.index : Number.POSITIVE_INFINITY
      })
      .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY)
    return trimmed.slice(start, next === Number.POSITIVE_INFINITY ? undefined : next)
  }

  const knownTitles = new Map(
    store
      .listWorldbuild(projectId)
      .filter((e) => e.title.trim())
      .map((e) => [e.title.trim(), e])
  )

  const worldNew = normalizeWorldbuildParsed(
    projectId,
    parseWorldbuildEntries(seg('世界观新增'), []),
    { newTypeBudget: 1 }
  ).filter((e) => !knownTitles.has(e.title.trim()) && e.title.trim() !== '未命名条目')

  const worldUpdates: CanonWorldUpdate[] = []
  const seenUpdates = new Set<string>()
  for (const e of parseWorldbuildEntries(seg('世界观修订'), [])) {
    const hit = knownTitles.get(e.title.trim())
    if (!hit || !e.content.trim() || seenUpdates.has(e.title.trim())) continue
    if (e.content.trim() === hit.content.trim()) continue // 与原文一致 = 无实质修订
    seenUpdates.add(e.title.trim())
    worldUpdates.push({
      id: hit.id,
      title: hit.title,
      category: hit.category,
      tags: e.tags.length > 0 ? e.tags : splitTags(hit.tags),
      content: e.content
    })
  }

  const characters = parseCharacterCards(seg('新增人物'))
  let mainRole: string | undefined
  if (characters.main.trim()) {
    // 优先从主标题「## 名（定位）」剥括号提取（character-smith 惯例格式）
    const hm = /^(#{1,3}\s*)([^#（(\n]+?)\s*[（(](.+?)[）)]/.exec(characters.main)
    if (hm) {
      mainRole = hm[3].trim().slice(0, 30)
      characters.main = characters.main.replace(hm[0], `${hm[1]}${hm[2].trim()}`)
    } else {
      // 兼容「定位：」独立行写法
      const m = /^\s*定位[:：]\s*(.+)$/m.exec(characters.main)
      if (m) {
        mainRole = m[1].trim().slice(0, 30)
        characters.main = characters.main.replace(m[0], '').trim()
      }
    }
  }
  const hasChars = Boolean(characters.main.trim()) || characters.revisions.length > 0
  return { worldNew, worldUpdates, characters: hasChars ? characters : null, mainRole }
}
