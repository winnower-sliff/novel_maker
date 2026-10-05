import type { AgentToolCall, AgentTurn, ChatMessage, ContentBlock } from '@shared/types'

export const TOOL_LABELS: Record<string, string> = {
  get_project: '项目·读取',
  update_project: '项目·修改',
  list_characters: '人物·列表',
  get_character: '人物·读取',
  save_character: '人物·保存',
  delete_character: '人物·删除',
  list_worldbuild: '世界观·列表',
  get_worldbuild: '世界观·读取',
  save_worldbuild: '世界观·保存',
  delete_worldbuild: '世界观·删除',
  list_outlines: '大纲·列表',
  save_outline: '大纲·保存',
  delete_outline: '大纲·删除',
  list_chapter_briefs: '章节·状态',
  get_chapter: '正文·读取',
  save_chapter: '正文·写入',
  list_foreshadows: '伏笔·列表',
  save_foreshadow: '伏笔·保存',
  delete_foreshadow: '伏笔·删除',
  get_agent_instructions: '指令·读取',
  set_agent_instructions: '指令·修改',
  spawn_subagent: '子智能体·委派',
  get_entity: '内容·读取',
  delete_entity: '内容·删除',
  worldbuild_type: '世界观·类型管理',
  set_worldbuild_category: '世界观·改类型',
  grep_project: '全项目·查找',
  compact_context: '上下文·压缩'
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key]
  return typeof v === 'string' ? v : ''
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}

export function toolSummary(call: AgentToolCall): string {
  const i = call.input
  switch (call.name) {
    case 'save_chapter': {
      const words = str(i, 'content').replace(/\s/g, '').length
      return `写入章节正文（${words} 字）`
    }
    case 'save_character':
      return `${str(i, 'id') ? '修改人物' : '新建人物'}：${str(i, 'name') || '(未命名)'}`
    case 'save_worldbuild':
      return `${str(i, 'id') ? '修改词条' : '新建词条'}：${str(i, 'title') || '(无标题)'}`
    case 'set_agent_instructions':
      return `${str(i, 'scope') === 'global' ? '写入全局 agents.md' : '写入本项目指令'}（${str(i, 'text').length} 字）`
    case 'spawn_subagent': {
      const t = str(i, 'task')
      return `${str(i, 'role') || '调研'}：${t.slice(0, 40)}${t.length > 40 ? '…' : ''}`
    }
    case 'get_entity': {
      const kindName =
        { character: '人物', worldbuild: '词条', chapter: '章节' }[str(i, 'kind')] ?? str(i, 'kind')
      return `读取${kindName}全文（id 前 8 位 ${str(i, 'id').slice(0, 8)}）`
    }
    case 'delete_entity': {
      const kindName =
        { character: '人物', worldbuild: '词条', outline: '大纲', foreshadow: '伏笔' }[
          str(i, 'kind')
        ] ?? str(i, 'kind')
      return `删除${kindName}（id 前 8 位 ${str(i, 'id').slice(0, 8)}）`
    }
    case 'worldbuild_type': {
      const op = str(i, 'op')
      const opName = { create: '新建类型', delete: '删除类型', reorder: '调整顺序' }[op] ?? op
      return `世界观类型·${opName}：${str(i, 'name')}`
    }
    case 'set_worldbuild_category':
      return `词条改类型：${str(i, 'category')}（id 前 8 位 ${str(i, 'id').slice(0, 8)}）`
    case 'grep_project': {
      const p = str(i, 'pattern')
      return `全项目查找：${p.slice(0, 30)}${p.length > 30 ? '…' : ''}${str(i, 'regex') ? '（正则）' : ''}`
    }
    case 'compact_context': {
      const s2 = str(i, 'summary')
      return `压缩对话历史（摘要 ${s2.length} 字）`
    }
    default:
      return toolLabel(call.name)
  }
}

export function turnsToMessages(turns: AgentTurn[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const turn of turns) {
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

export function finalizeTurns(turns: AgentTurn[]): AgentTurn[] {
  return turns.map((t) =>
    t.role === 'assistant'
      ? {
          ...t,
          toolCalls: t.toolCalls.map((c) =>
            c.state === 'running' || c.state === 'confirming'
              ? { ...c, state: 'error' as const, result: c.result ?? '（已中断）' }
              : c
          )
        }
      : t
  )
}
