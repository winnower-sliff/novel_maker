import type { AgentToolCallEvent, AgentToolResultEvent } from '../../../shared/contract'
import { classifyLlmError } from '../../../shared/llmError'
import type { ChatMessage, ContentBlock } from '../../../shared/types'

/** 上下文窗口未知（custom/异常 provider）时的保守回退值 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** 输入 token 占窗口比超过该比率时在工具结果里软提示建议模型自主压缩（不强制，每轮至多一次） */
export const COMPACT_NUDGE_RATIO = 0.6

/** 输入+输出 token 占窗口比超过该比率时程序化主动压缩（不等 context_too_long 报错） */
export const PROACTIVE_COMPACT_RATIO = 0.8

/** 自动压缩兜底预算：输入超限（context_too_long）时程序化压缩的次数与保留字符预算（二级递减） */
export const MAX_AUTO_COMPACTS = 2
export const AUTO_COMPACT_BUDGET = 30_000
export const AUTO_COMPACT_BUDGET_HARD = 8_000

/** 单条消息粗估字符量（自动压缩预算用，无需精确 token） */
export function msgSize(m: ChatMessage): number {
  if (typeof m.content === 'string') return m.content.length
  let n = 0
  for (const b of m.content) {
    if (b.type === 'text') n += b.text.length
    else if (b.type === 'tool_use') n += JSON.stringify(b.input ?? {}).length + 40
    else if (b.type === 'tool_result')
      n +=
        (typeof b.content === 'string'
          ? b.content.length
          : JSON.stringify(b.content ?? '').length) + 20
  }
  return n
}

export function isToolResultMsg(m: ChatMessage): boolean {
  return (
    m.role === 'user' &&
    Array.isArray(m.content) &&
    m.content.length > 0 &&
    m.content.every((b) => b.type === 'tool_result')
  )
}

interface MsgGroup {
  msgs: ChatMessage[]
  size: number
  toolNames: string[]
}

/** 按轮切原子组：assistant 与其紧随的 tool_result user 绑定（配对约束不可拆散），普通 user 独立成组 */
export function groupMessages(messages: ChatMessage[]): MsgGroup[] {
  const groups: MsgGroup[] = []
  for (let i = 0; i < messages.length; ) {
    const m = messages[i]
    if (m.role === 'assistant') {
      const next = messages[i + 1]
      const msgs = next && isToolResultMsg(next) ? [m, next] : [m]
      i += msgs.length
      const toolNames: string[] = []
      if (Array.isArray(m.content))
        for (const b of m.content) if (b.type === 'tool_use') toolNames.push(b.name)
      groups.push({ msgs, size: msgs.reduce((n, x) => n + msgSize(x), 0), toolNames })
    } else {
      groups.push({ msgs: [m], size: msgSize(m), toolNames: [] })
      i++
    }
  }
  return groups
}

export function userText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content
  return m.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

export function firstUserText(messages: ChatMessage[]): string {
  const first = messages[0]
  if (first?.role !== 'user') return ''
  return userText(first)
}

/**
 * 程序化自动压缩（输入超限兜底）：从尾往前按字符预算保留最近的工作（原子组切割），
 * 早期历史替换为线索摘要（原始任务 + 被丢弃段的工作统计），至少保留最后一组。
 * 落库为合成 compact_context 调用（input.summary 非空），重开会话回灌时按摘要裁剪。
 */
export function buildAutoCompact(
  messages: ChatMessage[],
  budget: number
): { summary: string; kept: ChatMessage[] } {
  const groups = groupMessages(messages)
  const kept: MsgGroup[] = []
  let used = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]
    if (kept.length > 0 && used + g.size > budget) break
    kept.unshift(g)
    used += g.size
  }
  const lines: string[] = []
  const taskText = firstUserText(messages).slice(0, 800).trim()
  if (taskText.startsWith('【上下文压缩】')) {
    lines.push(`前次压缩摘要（继承，可能截取）：\n${taskText}`)
  } else if (taskText) {
    lines.push(`原始任务（截取）：${taskText}`)
  }
  // 前次压缩摘要组若落在保留区头部：内容已继承进新摘要，剔除避免双份
  let absorbed = 0
  if (
    kept.length > 1 &&
    kept[0].msgs[0]?.role === 'user' &&
    userText(kept[0].msgs[0]).startsWith('【上下文压缩】')
  ) {
    kept.shift()
    absorbed++
  }
  // 保留区头部若是普通 user 指令：并入摘要行，避免摘要后紧跟连续 user 消息（兼容层风险）
  if (kept.length > 1) {
    const head = kept[0].msgs[0]
    if (head?.role === 'user' && !isToolResultMsg(head)) {
      const t = userText(head).slice(0, 400).trim()
      if (t) lines.push(`用户中途指令（保留）：${t}`)
      kept.shift()
      absorbed++
    }
  }
  const dropped = groups.slice(0, groups.length - kept.length - absorbed)
  if (dropped.length > 0) {
    const toolCount = new Map<string, number>()
    for (const g of dropped)
      for (const n of g.toolNames) toolCount.set(n, (toolCount.get(n) ?? 0) + 1)
    const stat = [...toolCount.entries()].map(([n, c]) => `${n}×${c}`).join('、')
    lines.push(
      `已省略早期 ${dropped.length} 组对话${stat ? `（工具调用：${stat}）` : ''}：详细内容已不可恢复，需要早期结论或数据时用工具重新查询项目资料，不要凭空回忆`
    )
  }
  lines.push('以下从最近的工作继续，直接调用工具完成任务')
  return { summary: lines.join('\n'), kept: kept.flatMap((g) => g.msgs) }
}

/** 压缩与轮次统计的共享计数器：loop 骨架创建，各 policy 引用同一对象 */
export interface LoopCounters {
  autoContinues: number
  autoCompacts: number
  compacted: boolean
  compactSummary: string
}

export function createLoopCounters(): LoopCounters {
  return { autoContinues: 0, autoCompacts: 0, compacted: false, compactSummary: '' }
}

export interface CompactPolicy {
  /** chatStream 抛错时调用：输入超限兜底。返回 true=已程序化压缩可立即重试；骨架负责半截文本 flush 与计数 */
  onContextTooLong(err: unknown, signal: AbortSignal): boolean
  /** 每轮工具落账后主动压缩判断。返回 true=已压缩需立即重开一轮 */
  afterTurn(
    inputTokens: number,
    outputTokens: number,
    hadToolUses: boolean,
    signal: AbortSignal
  ): boolean
  /** COMPACT_NUDGE：输入逼近窗口时在最后一个 tool_result 后追加软提示 */
  appendNudge(blocks: ContentBlock[], inputTokens: number): void
}

/**
 * 程序化压缩策略（主动 80% 预防与被动超限兜底共用执行体）：
 * 发 compact_context 合成卡 + 整体替换 messages 为 摘要+kept。
 */
export function createCompactPolicy(opts: {
  counters: LoopCounters
  messages: ChatMessage[]
  contextWindow: number
  emitToolCall: (call: AgentToolCallEvent) => void
  emitToolResult: (ev: AgentToolResultEvent) => void
}): CompactPolicy {
  const { counters, messages, contextWindow, emitToolCall, emitToolResult } = opts

  /** 落 compact 卡（保证重开会话回灌也会裁剪）+ 整体替换 messages */
  const applyCompact = (summary: string, kept: ChatMessage[], note: string): void => {
    const cid = `auto_compact_${Date.now()}`
    const call: AgentToolCallEvent = {
      id: cid,
      name: 'compact_context',
      input: { summary },
      state: 'running'
    }
    emitToolCall(call)
    emitToolResult({ id: cid, ok: true, result: note })
    messages.length = 0
    messages.push({
      role: 'user',
      content: `【上下文压缩】以下摘要替代了此前全部对话历史：\n${summary}`
    })
    messages.push(...kept)
    counters.compacted = true
    counters.compactSummary = summary
  }

  return {
    onContextTooLong(err, signal) {
      const errMsg = (err as Error)?.message ?? String(err)
      if (
        signal.aborted ||
        counters.autoCompacts >= MAX_AUTO_COMPACTS ||
        classifyLlmError(errMsg).category !== 'context_too_long'
      )
        return false
      const budget = counters.autoCompacts === 0 ? AUTO_COMPACT_BUDGET : AUTO_COMPACT_BUDGET_HARD
      const { summary, kept } = buildAutoCompact(messages, budget)
      counters.autoCompacts++
      applyCompact(
        summary,
        kept,
        `已自动压缩（第 ${counters.autoCompacts} 次）：输入超出模型上下文长度限制，早期历史已替换为线索摘要，保留了最近的工作。不要输出确认性文字，直接继续调用工具完成任务`
      )
      return true
    },

    afterTurn(inputTokens, outputTokens, hadToolUses, signal) {
      const usedTokens = inputTokens + outputTokens
      if (
        !signal.aborted &&
        hadToolUses &&
        counters.autoCompacts < MAX_AUTO_COMPACTS &&
        usedTokens >= PROACTIVE_COMPACT_RATIO * contextWindow
      ) {
        const { summary, kept } = buildAutoCompact(messages, AUTO_COMPACT_BUDGET)
        counters.autoCompacts++
        applyCompact(
          summary,
          kept,
          `已主动压缩（第 ${counters.autoCompacts} 次）：上下文用量约 ${usedTokens} tokens，已达窗口（约 ${contextWindow}）的 ${Math.round(PROACTIVE_COMPACT_RATIO * 100)}%，早期历史已替换为线索摘要，保留了最近的工作。不要输出确认性文字，直接继续调用工具完成任务`
        )
        return true
      }
      return false
    },

    appendNudge(blocks, inputTokens) {
      if (inputTokens < COMPACT_NUDGE_RATIO * contextWindow || blocks.length === 0) return
      const last = blocks[blocks.length - 1]
      if (last.type !== 'tool_result') return
      last.content += `\n[系统提示：本次请求输入约 ${inputTokens} tokens（窗口约 ${contextWindow}），上下文偏大。若早前细节已不再需要，建议调用 compact_context 压缩历史（先把任务目标、已完成修改含 id、待办事项写进摘要），压缩后直接继续调用工具，不要停下来等待确认]`
    }
  }
}
