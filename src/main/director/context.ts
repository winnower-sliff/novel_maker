import type { Book, Card, Character, StatusCard } from '../../shared/types.js'
import {
  activeLine,
  effectiveChapters,
  getBook,
  getRunningMemory,
  listCards,
  listCharacters,
  listForeshadows,
  listMemories
} from '../store.js'

/**
 * 写作简报（导演与写手共用的同一份上下文，M3）：
 * 钉选设定 → 前情梗概 → 人物 → 伏笔 → 本章出场人物人设 → 相关设定卡 → 近章细记 → 本章计划。
 * 稳定内容在前、每章都变的在后（DeepSeek 前缀缓存按前缀整体命中）。
 * 预算（字符）：引用≤35%、历史≤25%、检索≤15%，超限从低优先级截断。
 */

const BUDGET_TOTAL = 24000
const BUDGET_REF = Math.floor(BUDGET_TOTAL * 0.35)
const BUDGET_HISTORY = Math.floor(BUDGET_TOTAL * 0.25)
const BUDGET_LOOKUP = Math.floor(BUDGET_TOTAL * 0.15)

/** 近章细记带最后几章（更早的靠前情梗概） */
const RECENT_CHAPTERS = 8
/** 前情梗概入库时已卡在 2200 字内；这里只是防脏数据的兜底上限 */
const RECAP_MAX = 3000
const MAX_FOCUS_CHARACTERS = 6
const MAX_RELATED_CARDS = 5
const PERSONA_DATA_MAX = 600
const CARD_DATA_MAX = 1500

export interface BriefFocus {
  /** 本章大纲、作者交代等文本：用来挑「本章出场人物」与「相关设定卡」 */
  text?: string
  /** 计划模式下已批准的本章计划 */
  plan?: string
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（截断）`
}

function cardText(card: Card): string {
  const parts = [`【${card.title}】(${card.kind})`]
  if (card.readerText) parts.push(`读者已知：${card.readerText}`)
  if (card.authorText) parts.push(`作者真相：${card.authorText}`)
  if (card.revealPlan) parts.push(`揭示计划：${card.revealPlan}`)
  return parts.join('\n')
}

function characterText(c: Character): string {
  const st = Object.entries(c.state)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('；')
  const rel = c.relations.length
    ? `；关系：${c.relations.map((r) => `${r.to}(${r.label})`).join('、')}`
    : ''
  return `【${c.name}】${c.role ? `（${c.role}）` : ''}${st ? ` 状态：${st}` : ''}${rel}`
}

/** 出场人物的人设（data）+ 现状（state）+ 关系 */
function characterPersona(c: Character): string {
  const data = Object.entries(c.data)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('；')
  return `${characterText(c)}${data ? `\n人设：${clip(data, PERSONA_DATA_MAX)}` : ''}`
}

/** 设定卡全文，带完整 data */
function cardFull(card: Card): string {
  const hasData = card.data && Object.keys(card.data).length > 0
  return `${cardText(card)}${hasData ? `\n数据：${clip(JSON.stringify(card.data), CARD_DATA_MAX)}` : ''}`
}

/**
 * 本章出场人物：按大纲/交代里点名的人物挑（名字或定位被提到），
 * 不足时补钉选人物；一个都没点名时至少带前两位（主角人设是人物不跑偏的地基）。
 */
function pickCharacters(lineId: string, text: string): Character[] {
  const all = listCharacters(lineId)
  const named = text
    ? all.filter(
        (c) => (c.name.length >= 2 && text.includes(c.name)) || (c.role && text.includes(c.role))
      )
    : []
  const fill = all.filter((c) => c.pinned && !named.includes(c))
  const picked = [...named, ...fill].slice(0, MAX_FOCUS_CHARACTERS)
  return picked.length ? picked : all.slice(0, 2)
}

/** 相关设定卡：非钉选卡里标题或标签在本章文本里被提到的，按命中多少排序 */
function pickCards(lineId: string, text: string): Card[] {
  if (!text) return []
  return listCards(lineId)
    .filter((c) => !c.pinned)
    .map((card) => {
      let score = card.title && text.includes(card.title) ? 3 : 0
      for (const tag of card.tags) if (tag && text.includes(tag)) score += 2
      return { card, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELATED_CARDS)
    .map((x) => x.card)
}

/**
 * 写作简报：导演（get_write_context / 系统提示）与写手（正文、改稿、审读、诊断）共用。
 * 不带 focus = 通用简报；写手动笔前传本章大纲等文本，会多带出场人物人设与相关设定卡。
 */
export function buildStoryBrief(_book: Book, lineId: string, focus: BriefFocus = {}): string {
  const sections: string[] = []
  const text = focus.text ?? ''

  // 1. 钉选引用（B7：钉选必进上下文）
  const pinnedCards = listCards(lineId).filter((c) => c.pinned)
  const pinnedChars = listCharacters(lineId).filter((c) => c.pinned)
  const refParts: string[] = []
  for (const c of pinnedCards) refParts.push(cardText(c))
  for (const c of pinnedChars) refParts.push(characterText(c))
  if (refParts.length) {
    sections.push(`## 钉选设定（作者指定每次必带）\n${clip(refParts.join('\n\n'), BUDGET_REF)}`)
  }

  // 2. 前情梗概（合并式：每线一行，新章入书后更新，整段注入不截尾）；
  //    还没有时回退到旧的逐章压缩块（legacy，不再新增）
  const running = getRunningMemory(lineId)
  if (running) {
    sections.push(`## 前情梗概（第 1-${running.toOrder} 章）\n${clip(running.content, RECAP_MAX)}`)
  } else {
    const mems = listMemories(lineId, 'legacy')
    if (mems.length) {
      const lines = mems.map((m) => `第${m.fromOrder}-${m.toOrder}章：${clip(m.content, 800)}`)
      sections.push(`## 更早前情（压缩摘要）\n${clip(lines.join('\n'), BUDGET_HISTORY)}`)
    }
  }

  // 3. 人物现状 + 伏笔台账（检索层）。「第 N 章」= 本线有效章序列里的位置（分叉线的章序号会从 1 重排）
  const chapters = effectiveChapters(lineId)
  const orderOf = (id: string): number | null => {
    const at = chapters.findIndex((c) => c.id === id)
    return at >= 0 ? at + 1 : null
  }
  const nextOrder = chapters.length + 1
  const mainChars = listCharacters(lineId).slice(0, 8)
  if (mainChars.length) {
    sections.push(`## 人物现状\n${clip(mainChars.map(characterText).join('\n'), BUDGET_LOOKUP)}`)
  }
  const fs = listForeshadows(lineId).filter((f) => f.status !== 'resolved')
  if (fs.length) {
    const lines = fs.slice(0, 20).map((f) => {
      const planned = f.plannedChapterId ? orderOf(f.plannedChapterId) : null
      return `- ${f.title}：${clip(f.detail, 120)}${planned ? `（计划于第 ${planned} 章前后回收）` : ''}${
        nextOrder >= (planned ?? Number.POSITIVE_INFINITY) ? ' ←已到期，优先考虑回收' : ''
      }`
    })
    sections.push(`## 未闭合伏笔\n${clip(lines.join('\n'), BUDGET_LOOKUP)}`)
  }

  // 4. 本章出场人物的人设 + 相关设定卡（只有带 focus 时才有）
  if (text) {
    const cast = pickCharacters(lineId, text)
    if (cast.length) {
      sections.push(
        `## 本章出场人物（人设与现状，言行要对得上人设）\n${clip(cast.map(characterPersona).join('\n\n'), BUDGET_LOOKUP)}`
      )
    }
    const related = pickCards(lineId, text)
    if (related.length) {
      sections.push(
        `## 本章相关设定卡（细节以此为准，不要另编）\n${clip(related.map(cardFull).join('\n\n'), BUDGET_LOOKUP)}`
      )
    }
  }

  // 5. 最近章细记
  const recent = chapters.slice(-RECENT_CHAPTERS)
  if (recent.length) {
    const lines = recent.map((c) => `第${orderOf(c.id)}章《${c.title}》：${clip(c.summary, 300)}`)
    sections.push(`## 最近章节\n${clip(lines.join('\n'), BUDGET_HISTORY)}`)
    const prev = chapters[chapters.length - 1]
    if (prev?.content) {
      sections.push(`## 上一章结尾（接缝参考，不得重复）\n${clip(prev.content.slice(-500), 600)}`)
    }
  }

  // 6. 计划模式下已批准的本章计划（最动态，放最后）
  if (focus.plan?.trim()) {
    sections.push(`## 本章计划（作者已批准，按它写）\n${clip(focus.plan.trim(), 2000)}`)
  }

  return sections.join('\n\n')
}

/** 写作上下文（get_write_context 工具与各步骤 prompt 用）= 不带本章 focus 的通用简报 */
export function buildWriteContext(_book: Book, lineId: string): string {
  return buildStoryBrief(_book, lineId)
}

function plannedOrderText(
  chapterId: string,
  chapters: Array<{ id: string; orderNo: number }>
): number | null {
  const hit = chapters.find((c) => c.id === chapterId)
  return hit ? hit.orderNo : null
}

/** 现状卡（W1：纯数据组装，零模型成本） */
export function buildStatusCard(bookId: string): StatusCard | null {
  const book = getBook(bookId)
  if (!book) return null
  const line = activeLine(book)
  if (!line) return null
  const chapters = effectiveChapters(line.id)
  const last = chapters[chapters.length - 1] ?? null
  const fs = listForeshadows(line.id).filter((f) => f.status !== 'resolved')
  const chars = listCharacters(line.id)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned))
    .slice(0, 6)
  const staleDays = last ? Math.floor((Date.now() - last.updatedAt) / 86400000) || null : null
  return {
    bookId,
    bookTitle: book.title,
    lineName: line.name,
    chapterCount: chapters.length,
    lastChapter: last
      ? {
          orderNo: last.orderNo,
          title: last.title,
          summary: last.summary,
          updatedAt: last.updatedAt
        }
      : null,
    openForeshadows: fs.slice(0, 12).map((f) => ({
      title: f.title,
      detail: f.detail,
      status: f.status,
      plannedOrder: plannedOrderText(f.plannedChapterId, chapters)
    })),
    characters: chars.map((c) => ({ name: c.name, role: c.role, state: c.state })),
    staleDays: staleDays !== null && staleDays > 7 ? staleDays : null
  }
}
