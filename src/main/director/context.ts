import type { Book, Card, Character, StatusCard } from '../../shared/types.js'
import {
  activeLine,
  effectiveChapters,
  getBook,
  listCards,
  listCharacters,
  listForeshadows,
  listMemories
} from '../store.js'

/**
 * 上下文装配（G7）：钉选卡 → 本轮任务 → 伏笔/人物状态 → 最近章细记 → 远端压缩摘要。
 * 预算（字符）：引用≤35%、历史≤25%、检索≤15%，超限从低优先级截断。
 * M2 检索层=伏笔台账+人物活状态；语义嵌入 M5 接入后并入此层。
 */

const BUDGET_TOTAL = 24000
const BUDGET_REF = Math.floor(BUDGET_TOTAL * 0.35)
const BUDGET_HISTORY = Math.floor(BUDGET_TOTAL * 0.25)
const BUDGET_LOOKUP = Math.floor(BUDGET_TOTAL * 0.15)

const RECENT_DETAIL_COUNT = 5

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
    .map(([k, v]) => `${k}=${v}`)
    .join('；')
  const rel = c.relations.length
    ? `；关系：${c.relations.map((r) => `${r.to}(${r.label})`).join('、')}`
    : ''
  return `【${c.name}】${c.role ? `（${c.role}）` : ''}${st ? ` 状态：${st}` : ''}${rel}`
}

/** 写作上下文（给各步骤 prompt 用） */
export function buildWriteContext(book: Book, lineId: string): string {
  const sections: string[] = []

  // 1. 钉选引用（B7：钉选必进上下文）
  const pinnedCards = listCards(lineId).filter((c) => c.pinned)
  const pinnedChars = listCharacters(lineId).filter((c) => c.pinned)
  const refParts: string[] = []
  for (const c of pinnedCards) refParts.push(cardText(c))
  for (const c of pinnedChars) refParts.push(characterText(c))
  if (refParts.length) {
    sections.push(`## 钉选设定（作者指定每次必带）\n${clip(refParts.join('\n\n'), BUDGET_REF)}`)
  }

  // 2. 伏笔台账 + 人物活状态（检索层）
  const chapters = effectiveChapters(lineId)
  const nextOrder = (chapters.length ? (chapters[chapters.length - 1]?.orderNo ?? 0) : 0) + 1
  const fs = listForeshadows(lineId).filter((f) => f.status !== 'resolved')
  if (fs.length) {
    const lines = fs.slice(0, 20).map((f) => {
      const planned = f.plannedChapterId ? plannedOrderText(f.plannedChapterId, chapters) : null
      return `- ${f.title}：${clip(f.detail, 120)}${planned ? `（计划于第 ${planned} 章前后回收）` : ''}${
        nextOrder >= (planned ?? Number.POSITIVE_INFINITY) ? ' ←已到期，优先考虑回收' : ''
      }`
    })
    sections.push(`## 未闭合伏笔\n${clip(lines.join('\n'), BUDGET_LOOKUP)}`)
  }
  const mainChars = listCharacters(lineId).slice(0, 8)
  if (mainChars.length) {
    sections.push(`## 人物现状\n${clip(mainChars.map(characterText).join('\n'), BUDGET_LOOKUP)}`)
  }

  // 3. 最近章细记（滚动分层——细记层）
  const recent = chapters.slice(-RECENT_DETAIL_COUNT)
  if (recent.length) {
    const lines = recent.map((c) => `第${c.orderNo}章《${c.title}》：${clip(c.summary, 300)}`)
    sections.push(`## 最近章节\n${clip(lines.join('\n'), BUDGET_HISTORY)}`)
    const prev = chapters[chapters.length - 1]
    if (prev?.content) {
      sections.push(`## 上一章结尾（接缝参考，不得重复）\n${clip(prev.content.slice(-500), 600)}`)
    }
  }

  // 4. 远端压缩前情（滚动分层——压缩层）
  const mems = listMemories(lineId)
  if (mems.length) {
    const lines = mems.map((m) => `第${m.fromOrder}-${m.toOrder}章：${clip(m.content, 800)}`)
    sections.push(`## 更早前情（压缩摘要）\n${clip(lines.join('\n'), BUDGET_HISTORY)}`)
  }

  return sections.join('\n\n')
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
