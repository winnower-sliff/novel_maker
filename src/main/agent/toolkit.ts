import type { OutlineItem, ToolDef, UsageInfo } from '../../shared/types'
import type { EventSink } from '../eventSink'
import * as store from '../store'

export const MAX_TURNS = 24
export const MAX_CHAPTER_CHARS = 8000
export const MAX_RESULT_CHARS = 30000
export const BRIEF_CHARS = 200
export const FULL_PAGE_DEFAULT = 20

export const AGENT_MAX_TOKENS = 8192

export const MAX_SUB_TURNS = 10
export const MAX_SUBAGENTS = 6
export const SUB_REPORT_CHARS = 8000
export const SUB_MAX_TOKENS = 4096

export interface ToolInput {
  [key: string]: unknown
}

export interface ToolExecContext {
  sink: EventSink
  requestId: string
  parentId: string
  projectId: string
  usage: UsageInfo
  signal: AbortSignal
  model: string
  apiKey: string
  baseUrl: string
  promptCache: boolean
}

export interface AgentTool {
  def: ToolDef
  danger: boolean
  handler: (input: ToolInput, projectId: string) => unknown
  dangerCheck?: (input: ToolInput, projectId: string) => string | null
  execCtx?: (input: ToolInput, ctx: ToolExecContext) => Promise<unknown>
}

export function schema(
  props: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return { type: 'object', properties: props, required }
}

export function s(desc: string): Record<string, unknown> {
  return { type: 'string', description: desc }
}

export function optS(desc: string): Record<string, unknown> {
  return { type: 'string', description: `${desc}（可选）` }
}

export function optN(desc: string): Record<string, unknown> {
  return { type: 'number', description: `${desc}（可选）` }
}

export function optB(desc: string): Record<string, unknown> {
  return { type: 'boolean', description: `${desc}（可选）` }
}

export function reqStr(input: ToolInput, key: string): string {
  const v = input[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 缺失或为空`)
  return v
}

export function optStr(input: ToolInput, key: string): string | undefined {
  const v = input[key]
  return typeof v === 'string' ? v : undefined
}

function _reqNum(input: ToolInput, key: string): number {
  const v = input[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`参数 ${key} 必须为数字`)
  return v
}

export function optNum(input: ToolInput, key: string): number | undefined {
  const v = input[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max)}\n…[已截断，原文共 ${text.length} 字]`, truncated: true }
}

export function briefOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, BRIEF_CHARS)
}

export function getOutlineOwned(outlineId: string, projectId: string): OutlineItem {
  const outline = store.getOutline(outlineId)
  if (!outline || outline.projectId !== projectId) throw new Error(`大纲条目 ${outlineId} 不存在`)
  return outline
}
