import type { AgentToolCallEvent, AgentToolResultEvent } from '../../shared/contract'
import type { Protocol } from '../../shared/providers'
import type { ChatMessage, ContentBlock, ToolDef, UsageInfo } from '../../shared/types'
import { chatStream, pickRatelimitHeaders } from '../llm'
import { appendUsage } from '../usage'
import { executeToolCalls, recoverCalls } from './executor'
import type { LoopCounters } from './policy/compact'
import type { AgentTool, ToolInput } from './toolkit'

/** loop 事件出口：主代理直发 agent:* 通道，子代理包装为 subEvent（组装层吸收差异） */
export interface LoopEmit {
  delta(text: string): void
  toolCall(call: AgentToolCallEvent): void
  toolResult(ev: AgentToolResultEvent): void
}

export interface LoopConfig {
  system: string
  tools: ToolDef[]
  toolMap: Map<string, AgentTool>
  /** 只读工具集合（不计 changed） */
  readTools: ReadonlySet<string>
  /** 工具执行的项目上下文（CRUD handler 按它定位数据） */
  projectId: string
  model: string
  maxTokens: number
  promptCache: boolean
  apiKey: string
  baseUrl: string
  protocol: Protocol
  maxTurns: number
  signal: AbortSignal
}

export interface TurnEndState {
  turn: number
  toolUseCount: number
  inputTokens: number
  outputTokens: number
  hadToolUses: boolean
  /** 本轮模型是否自主压缩过（自主压缩当轮不再程序化主动压缩） */
  selfCompacted: boolean
}

export interface LoopHooks {
  emit: LoopEmit
  /** 共享用量账本（主/子代理同一 run 汇总） */
  usage: UsageInfo
  counters: LoopCounters
  /** danger 工具确认流（缺省一律拒绝） */
  confirm?: (call: AgentToolCallEvent) => Promise<boolean>
  /** 本 run 的「总是允许」工具白名单（命中跳过确认流） */
  isAlwaysAllowed?: (toolName: string) => boolean
  /** 计划执行期写授权闸门（透传 executor.writeGuard）：返回拒绝理由则该调用短路 */
  writeGuard?: (name: string, input: import('./toolkit').ToolInput) => string | null
  /** 自主压缩工具名拦截（主代理 compact_context；缺省无此特判）：空 summary 报错，有效 summary 延迟整体替换 */
  selfCompact?: { toolName: string }
  /** chatStream 抛错兜底（context_too_long 程序化压缩）：返回 true=已处理需重试 */
  onStreamError?: (err: unknown, signal: AbortSignal) => boolean
  /** assistant 轮文本落库：final=true 无条件落（空文本保持结构占位）；final=false 仅非空落（流中断兜底） */
  onAssistantTurn?: (text: string, final: boolean) => void
  /** 轮末软提示追加（COMPACT_NUDGE） */
  appendNudge?: (blocks: ContentBlock[], inputTokens: number) => void
  /** 轮末钩子（主动压缩/注入安全点/看板提醒）：返回 true=已压缩需立即重开一轮 */
  onTurnEnd?: (state: TurnEndState) => Promise<boolean>
  /** 无工具调用收尾钩子（自动续跑判定）：返回注入文本则续跑（续跑计数由策略内部维护，骨架不重复计） */
  onStop?: (text: string, toolUseCount: number, compacted: boolean) => string | null
  /** spawn_subagent 预算（used 由 executor 递增） */
  subagentBudget?: { used: number; max: number }
  /** execCtx 类工具的执行上下文（子代理链路不需要再嵌套委派时缺省） */
  execCtxBase?: Omit<import('./toolkit').ToolExecContext, 'parentId'>
}

export interface LoopResult {
  text: string
  turns: number
  requests: number
  toolUseCount: number
  changed: boolean
  denied: boolean
  hitLimit: boolean
  usage: UsageInfo
  model: string
  autoContinues: number
  autoCompacts: number
  compacted: boolean
  compactSummary: string
  toolResults: AgentToolResultEvent[]
}

/**
 * agentic loop 纯骨架：主代理与子代理共用。
 * 只负责「LLM 请求 → 参数恢复 → 自主压缩拦截 → 工具执行 → 轮末钩子 → 停止判定」的
 * 流程编排；确认流、压缩、续跑、注入等策略经 hooks 注入，骨架不感知具体策略。
 */
export async function runLoop(
  messages: ChatMessage[],
  config: LoopConfig,
  hooks: LoopHooks
): Promise<LoopResult> {
  const { emit, usage, counters } = hooks
  const toolResults: AgentToolResultEvent[] = []
  const emitToolCall = (call: AgentToolCallEvent): void => emit.toolCall(call)
  const emitToolResult = (ev: AgentToolResultEvent): void => {
    toolResults.push(ev)
    emit.toolResult(ev)
  }

  let requests = 0
  let turnCount = 0
  let changed = false
  let denied = false
  let hitLimit = false
  let toolUseCount = 0
  let finalText = ''
  let lastModel = config.model
  let pendingCompact: string | null = null
  /** 当前 chatStream 已流出但尚未按轮落库的文本（中断/异常时在 finally 兜底持久化） */
  let pendingTurnText = ''

  try {
    for (let turn = 0; turn < config.maxTurns; turn++) {
      turnCount = turn + 1
      let result: Awaited<ReturnType<typeof chatStream>>
      try {
        result = await chatStream(
          {
            model: config.model,
            system: config.system,
            messages,
            tools: config.tools,
            maxTokens: config.maxTokens,
            purpose: 'agent',
            cacheSystem: config.promptCache
          },
          { apiKey: config.apiKey, baseUrl: config.baseUrl, protocol: config.protocol },
          (text) => {
            pendingTurnText += text
            emit.delta(text)
          },
          config.signal
        )
      } catch (err) {
        // 输入超限兜底：程序化压缩后重试（不耗 maxTurns），预算用尽才真报错
        if (hooks.onStreamError?.(err, config.signal)) {
          // 超限报错若发生在流中途（罕见）：已流出文本先落库再清，避免静默丢失
          if (pendingTurnText.trim()) hooks.onAssistantTurn?.(pendingTurnText, false)
          pendingTurnText = ''
          turn--
          continue
        }
        throw err
      }
      requests++
      // transcript 按轮合并落库（空文本也落：纯工具轮的结构需要 assistant 占位）
      hooks.onAssistantTurn?.(result.text, true)
      pendingTurnText = ''
      lastModel = result.model
      usage.inputTokens += result.usage.inputTokens
      usage.outputTokens += result.usage.outputTokens
      usage.cacheReadTokens += result.usage.cacheReadTokens
      usage.cacheCreationTokens += result.usage.cacheCreationTokens
      appendUsage({
        ts: Date.now(),
        model: result.model,
        purpose: 'agent',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
        durationMs: result.durationMs,
        ratelimit: pickRatelimitHeaders(result.headers)
      })

      if (result.toolUses.length === 0) {
        finalText = result.text
        // 自动续跑：任务疑似中途停摆时由策略注入合成消息继续；被中断不续，尊重用户停止意图
        if (!config.signal.aborted && hooks.onStop) {
          const inject = hooks.onStop(finalText, toolUseCount, counters.compacted)
          if (inject !== null) {
            messages.push({ role: 'user', content: inject })
            continue
          }
        }
        break
      }

      recoverCalls(result.toolUses)

      const assistantBlocks: ContentBlock[] = []
      if (result.text) assistantBlocks.push({ type: 'text', text: result.text })
      for (const tu of result.toolUses) {
        assistantBlocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
      }
      messages.push({ role: 'assistant', content: assistantBlocks })

      // 自主压缩拦截：不进通用执行流，先摘出处理（压缩必须在本轮 tool_result 全部落账后整体替换）
      const calls: {
        id: string
        name: string
        input: ToolInput
        inputError?: 'truncated' | 'invalid'
      }[] = []
      const headBlocks: ContentBlock[] = []
      let selfCompactedThisTurn = false
      for (const tu of result.toolUses) {
        if (hooks.selfCompact && tu.name === hooks.selfCompact.toolName) {
          toolUseCount++
          const call: AgentToolCallEvent = {
            id: tu.id,
            name: tu.name,
            input: tu.input,
            state: 'running'
          }
          emitToolCall(call)
          const summary = typeof tu.input?.summary === 'string' ? tu.input.summary.trim() : ''
          if (!summary) {
            const msg = '错误: summary 不能为空（把任务目标、已完成修改含 id、待办写进摘要再压缩）'
            headBlocks.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: msg,
              is_error: true
            })
            emitToolResult({ id: tu.id, ok: false, result: 'summary 不能为空' })
          } else {
            const msg =
              '已压缩：此前全部对话历史已替换为该摘要。不要输出确认性文字，直接继续调用工具执行下一步工作'
            headBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: msg })
            emitToolResult({ id: tu.id, ok: true, result: msg })
            pendingCompact = summary
            selfCompactedThisTurn = true
          }
          continue
        }
        calls.push(tu)
      }

      const outcome = await executeToolCalls(calls, {
        toolMap: config.toolMap,
        projectId: config.projectId,
        readTools: config.readTools,
        emitToolCall,
        emitToolResult,
        confirm: hooks.confirm,
        isAlwaysAllowed: hooks.isAlwaysAllowed,
        ...(hooks.writeGuard ? { writeGuard: hooks.writeGuard } : {}),
        execCtxBase: hooks.execCtxBase,
        subagentBudget: hooks.subagentBudget
      })
      toolUseCount += outcome.toolUseCount
      changed = changed || outcome.changed
      denied = denied || outcome.denied

      const resultBlocks = [...headBlocks, ...outcome.resultBlocks]
      hooks.appendNudge?.(resultBlocks, result.usage.inputTokens)
      messages.push({ role: 'user', content: resultBlocks })

      if (pendingCompact !== null) {
        messages.length = 0
        messages.push({
          role: 'user',
          content: `【上下文压缩】以下摘要替代了此前全部对话历史：\n${pendingCompact}`
        })
        counters.compacted = true
        counters.compactSummary = pendingCompact
        pendingCompact = null
      }

      // 轮末钩子（主动压缩/注入/看板）：压缩命中时重开一轮（不耗额度语义对齐现状 turn--）
      let retry = false
      if (hooks.onTurnEnd) {
        retry = await hooks.onTurnEnd({
          turn,
          toolUseCount,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          hadToolUses: true,
          selfCompacted: selfCompactedThisTurn
        })
      }
      if (retry) turn--

      if (turn === config.maxTurns - 1) hitLimit = true
    }
  } finally {
    if (pendingTurnText.trim()) hooks.onAssistantTurn?.(pendingTurnText, false)
  }

  return {
    text: finalText,
    turns: turnCount,
    requests,
    toolUseCount,
    changed,
    denied,
    hitLimit,
    usage,
    model: lastModel,
    autoContinues: counters.autoContinues,
    autoCompacts: counters.autoCompacts,
    compacted: counters.compacted,
    compactSummary: counters.compactSummary,
    toolResults
  }
}
