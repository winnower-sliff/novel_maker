import type {
  AgentToolCall,
  AgentTranscriptEvent,
  AgentTurn,
  ChatMessage,
  ContentBlock
} from './types'

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key]
  return typeof v === 'string' ? v : ''
}

/** 找最后一个 compact_context 调用点（压缩边界）；历史原样保留，仅用于查看与回灌裁剪 */
export function findCompactPoint(turns: AgentTurn[]): { index: number; summary: string } | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.role !== 'assistant') continue
    const call = t.toolCalls.find((c) => c.name === 'compact_context')
    if (!call) continue
    const summary = str(call.input, 'summary').trim()
    if (summary) return { index: i, summary }
  }
  return null
}

export function turnsToMessages(turns: AgentTurn[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  // 压缩感知：与主进程 run 内整体替换语义对齐——压缩点之前的全部历史只以摘要回灌，
  // 原始 turns 仅用于界面查看；找不到压缩点（老数据）时回退全量，宁可多带不丢上下文
  let effective = turns
  const cp = findCompactPoint(turns)
  if (cp) {
    messages.push({
      role: 'user',
      content: `【上下文压缩】以下摘要替代了此前全部对话历史：\n${cp.summary}`
    })
    effective = turns.slice(cp.index + 1)
  }
  for (const turn of effective) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.text })
      continue
    }
    const blocks: ContentBlock[] = []
    if (turn.text.trim()) blocks.push({ type: 'text', text: turn.text })
    const resultBlocks: ContentBlock[] = []
    for (const call of turn.toolCalls) {
      const denied = call.state === 'denied'
      if (call.result === undefined && !denied) continue
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: call.result ?? '用户拒绝了该操作',
        is_error: call.state === 'error' || denied || undefined
      })
    }
    if (blocks.length) messages.push({ role: 'assistant', content: blocks })
    if (resultBlocks.length) messages.push({ role: 'user', content: resultBlocks })
  }
  return messages
}

export function makeSessionTitle(turns: AgentTurn[]): string {
  const first = turns.find((t) => t.role === 'user')
  if (first?.role !== 'user') return '新会话'
  const text = first.text.trim()
  if (!text) return '新会话'
  return text.length > 20 ? `${text.slice(0, 20)}…` : text
}

/**
 * 事件流 → UI turns 投影（会话加载/增量补拉的统一装配器）。
 * user/assistant 各成 turn；tool_call 追加到最后一个 assistant turn；
 * tool_result 回填对应卡终态；run_error/done 把残留 running/confirming 卡
 * 收尾为 error（事件流有缺口时的防御性收场，保证 turns 永不悬挂）。
 */
export function eventsToTurns(events: AgentTranscriptEvent[]): AgentTurn[] {
  const turns: AgentTurn[] = []
  const cards = new Map<string, AgentToolCall>()
  for (const ev of events) {
    switch (ev.kind) {
      case 'user':
        turns.push({ role: 'user', text: ev.text, ts: ev.ts })
        break
      case 'assistant': {
        const turn: AgentTurn = { role: 'assistant', text: ev.text, toolCalls: [], ts: ev.ts }
        turns.push(turn)
        break
      }
      case 'tool_call': {
        const last = turns[turns.length - 1]
        const call: AgentToolCall = { ...ev.call }
        if (last && last.role === 'assistant') last.toolCalls.push(call)
        else turns.push({ role: 'assistant', text: '', toolCalls: [call], ts: ev.ts })
        cards.set(call.id, call)
        break
      }
      case 'tool_result': {
        const call = cards.get(ev.id)
        if (!call) break
        call.result = ev.result
        call.state = ev.denied ? 'denied' : ev.ok ? 'ok' : 'error'
        break
      }
      case 'run_error':
      case 'done': {
        const message = ev.kind === 'run_error' ? ev.message : '（结果未知）'
        for (const call of cards.values()) {
          if (call.state === 'running' || call.state === 'confirming') {
            call.state = 'error'
            call.result = `${message}（已中断）`
          }
        }
        break
      }
    }
  }
  return turns
}

export function eventsToMessages(events: AgentTranscriptEvent[]): ChatMessage[] {
  return turnsToMessages(eventsToTurns(events))
}
