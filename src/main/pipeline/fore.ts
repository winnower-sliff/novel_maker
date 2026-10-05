import { buildOutlineNoIndex, formatChapterRef } from '../../shared/foreRef'
import type { Foreshadow } from '../../shared/types'
import * as store from '../store'

export interface ForeLedger {
  text: string
  /** ref（F12）→ 伏笔 id，仅含本次注入的条目；调用方与落库方在无并发写入的前提下各调一次即可对齐 */
  mapping: Map<string, string>
}

/** 氛围级伏笔逐条注入上限，超出仅计数 */
const AMBIENCE_LIMIT = 20

/** 分层台账：主线/人物级全量，氛围级近埋优先限量；编号按 created_at 升序稳定生成 */
export function buildForeLedger(projectId: string, numbered: boolean): ForeLedger {
  const open = store.listForeshadows(projectId).filter((f) => f.status === 'open')
  const nosById = buildOutlineNoIndex(store.listOutlines(projectId))
  // uid 优先解析为当前章号（随重排自动跟随）；悬空标待重设，无 uid 回退旧文本
  const refOf = (text: string, uid: string): string => {
    const r = formatChapterRef(text, uid, nosById)
    return r === null ? '原定章节已删除，待重设' : r
  }
  const isAmbience = (f: Foreshadow) => f.priority.trim() === '氛围'
  const ambienceAll = open.filter(isAmbience)
  const ambienceShown = [...ambienceAll]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, AMBIENCE_LIMIT)
  const shown = [...open.filter((f) => !isAmbience(f)), ...ambienceShown].sort(
    (a, b) => a.createdAt - b.createdAt
  )
  const mapping = new Map<string, string>()
  const lines = shown.map((f, i) => {
    const ref = `F${i + 1}`
    mapping.set(ref, f.id)
    const extras: string[] = []
    if (f.priority.trim()) extras.push(`优先级：${f.priority.trim()}`)
    if (f.plannedResolve.trim() || f.plannedResolveOutlineId)
      extras.push(`计划回收：${refOf(f.plannedResolve, f.plannedResolveOutlineId)}`)
    const head = numbered ? `${ref}. ` : '- '
    const planted = f.plantedOutlineId
      ? refOf(f.plantedChapter, f.plantedOutlineId)
      : f.plantedChapter || '?'
    return `${head}${f.content.trim()}（埋于${planted}${extras.length ? `，${extras.join('，')}` : ''}）`
  })
  const hidden = ambienceAll.length - ambienceShown.length
  if (hidden > 0) lines.push(`（另有 ${hidden} 条氛围级伏笔未列出）`)
  return { text: lines.join('\n'), mapping }
}

/** 归一化：去空白与常见标点，用于落库兜底去重（宁漏勿误，只做等值比对） */
export function normalizeForeText(s: string): string {
  return s.replace(/[\s，。、；：？！「」『』（）《》“”‘’…·—\-,.:;?!()"'']/g, '')
}

export const FORE_REF_RE = /^F\d+$/

export const FORE_PRIORITIES = ['主线', '人物', '氛围'] as const
