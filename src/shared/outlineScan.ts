import type { OutlineRunProgress } from './types'

/**
 * 大纲流文本的增量章节扫描器：跨 chunk 维护 JSON 状态机，只统计已配平且带
 * string title 的对象（半截对象留在缓冲，下个 chunk 续扫；坏对象整体跳过）。
 * 主进程 send() 只喂已确认文本（重试丢弃的 pending 不经过 send），故进度不会
 * 被失败批次虚增；渲染端 widgets.tsx 的 scanOutlineProgress 复用同一状态机。
 */
export interface OutlineScanMachine {
  count: number
  titles: string[]
  /** 未闭合对象的嵌套深度（0 = 对象外） */
  depth: number
  inStr: boolean
  esc: boolean
  /** depth>0 时从对象起始 { 处累积的文本，配平时整体 JSON.parse */
  pending: string
}

export function createOutlineScanMachine(): OutlineScanMachine {
  return { count: 0, titles: [], depth: 0, inStr: false, esc: false, pending: '' }
}

export function feedOutlineScan(m: OutlineScanMachine, chunk: string): void {
  for (const ch of chunk) {
    if (m.depth > 0) m.pending += ch
    if (m.inStr) {
      if (m.esc) m.esc = false
      else if (ch === '\\') m.esc = true
      else if (ch === '"') m.inStr = false
      continue
    }
    if (ch === '"') m.inStr = true
    else if (ch === '{') {
      m.depth++
      if (m.depth === 1) m.pending = '{'
    } else if (ch === '}' && m.depth > 0) {
      m.depth--
      if (m.depth === 0) {
        try {
          const obj = JSON.parse(m.pending) as { title?: unknown }
          if (obj && typeof obj.title === 'string') {
            m.count++
            m.titles.push(obj.title)
            if (m.titles.length > 3) m.titles.splice(0, m.titles.length - 3)
          }
        } catch {
          // 坏对象（非章节 JSON）整体跳过，不影响后续扫描
        }
        m.pending = ''
      }
    }
  }
}

/** 当前进度快照（total<=0 时 count 仍有效，调用方决定展示形态） */
export function outlineProgressOf(m: OutlineScanMachine, total: number): OutlineRunProgress {
  return { count: m.count, total, lastTitles: [...m.titles] }
}
