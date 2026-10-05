import { findCompactPoint, makeSessionTitle, turnsToMessages } from '@shared/agentTranscript'
import type { AgentToolCall } from '@shared/types'

// turns 装配/压缩感知/消息回灌已迁 @shared/agentTranscript（服务端 rebuild 共用），此处 re-export 保持旧 import 路径
export { findCompactPoint, makeSessionTitle, turnsToMessages }

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
  compact_context: '上下文·压缩',
  get_outline_plan: '大纲·卷创意读取',
  save_outline_plan: '大纲·卷创意保存',
  get_chapter_tail: '正文·结尾回读',
  list_summaries: '摘要·列表',
  search_project: '语义·搜索',
  get_book_digest: '全书·概览',
  update_character_state: '人物·状态更新',
  refresh_volume_summary: '卷摘要·重建',
  reorder_worldbuild_type: '世界观·类型排序'
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key]
  return typeof v === 'string' ? v : ''
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}

export function toolSummary(call: AgentToolCall): string {
  const i = call.input
  switch (call.name) {
    case 'get_project':
      return '读取项目信息'
    case 'update_project':
      return `更新项目信息${str(i, 'title') ? `：${str(i, 'title')}` : ''}`
    case 'list_characters':
      return `查看人物列表${str(i, 'detail') === 'full' ? '（全文）' : ''}`
    case 'get_character':
      return `读取人物卡详情（id 前 8 位 ${str(i, 'id').slice(0, 8)}）`
    case 'save_character':
      return `${str(i, 'id') ? '修改人物' : '新建人物'}：${str(i, 'name') || '(未命名)'}`
    case 'delete_character':
      return `删除人物（id 前 8 位 ${str(i, 'id').slice(0, 8)}）`
    case 'list_worldbuild': {
      const cat = str(i, 'category')
      const parts = [cat, str(i, 'detail') === 'full' ? '全文' : ''].filter(Boolean)
      return `查看世界观词条${parts.length ? `（${parts.join('·')}）` : ''}`
    }
    case 'get_worldbuild':
      return `读取词条详情（id 前 8 位 ${str(i, 'id').slice(0, 8)}）`
    case 'save_worldbuild':
      return `${str(i, 'id') ? '修改词条' : '新建词条'}：[${str(i, 'category') || '?'}] ${str(i, 'title') || '(无标题)'}`
    case 'delete_worldbuild':
      return `删除世界观词条（id 前 8 位 ${str(i, 'id').slice(0, 8)}）`
    case 'list_outlines': {
      const v = num(i, 'volume')
      return `查看大纲列表${v ? `（第${v}卷）` : ''}`
    }
    case 'save_outline': {
      const no = num(i, 'chapterNo')
      return `${str(i, 'id') ? '修改' : '新建'}大纲${no ? `：第${no}章` : ''} ${str(i, 'title') || ''}`.trim()
    }
    case 'delete_outline':
      return `删除大纲条目（id 前 8 位 ${str(i, 'id').slice(0, 8)}）`
    case 'list_chapter_briefs':
      return '查看各章写作状态'
    case 'get_chapter':
      return '读取章节正文'
    case 'save_chapter': {
      const words = str(i, 'content').replace(/\s/g, '').length
      return `写入章节正文（${words} 字）`
    }
    case 'list_foreshadows':
      return '查看伏笔台账'
    case 'save_foreshadow': {
      const c = str(i, 'content')
      return `${str(i, 'id') ? '修改伏笔' : '新埋伏笔'}：${c.slice(0, 24)}${c.length > 24 ? '…' : ''}`
    }
    case 'delete_foreshadow':
      return `删除伏笔（id 前 8 位 ${str(i, 'id').slice(0, 8)}）`
    case 'get_agent_instructions':
      return '读取智能体行为指令'
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
    case 'get_outline_plan': {
      const v = num(i, 'volume')
      return `读取卷创意参数${v ? `（第${v}卷）` : ''}`
    }
    case 'save_outline_plan': {
      const v = num(i, 'volume')
      return `保存卷创意参数${v ? `（第${v}卷）` : ''}`
    }
    case 'get_chapter_tail':
      return `回读章节结尾（${num(i, 'chars') ?? 800} 字）`
    case 'list_summaries': {
      const v = num(i, 'volume')
      return `查看章节摘要${v ? `（第${v}卷）` : ''}`
    }
    case 'search_project': {
      const q = str(i, 'query')
      return `语义搜索：${q.slice(0, 30)}${q.length > 30 ? '…' : ''}`
    }
    case 'get_book_digest':
      return '读取全书概览'
    case 'update_character_state':
      return `更新人物状态：${str(i, 'name') || `id 前 8 位 ${str(i, 'id').slice(0, 8)}`}`
    case 'refresh_volume_summary':
      return `重建第 ${str(i, 'volume') || '?'} 卷卷摘要`
    case 'reorder_worldbuild_type':
      return `类型排序：${str(i, 'name')}`
    default:
      return call.name
  }
}
