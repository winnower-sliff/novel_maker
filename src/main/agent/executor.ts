import type { AgentToolCallEvent, AgentToolResultEvent } from '../../shared/contract'
import { recoverToolInput } from '../../shared/toolInput'
import type { ContentBlock } from '../../shared/types'
import {
  type AgentTool,
  clip,
  MAX_RESULT_CHARS,
  type ToolExecContext,
  type ToolInput
} from './toolkit'

/** 单次工具结果上限截断 + 超限补救指引（截断数据禁止下全局结论） */
export function serializeResult(data: unknown): string {
  let text: string
  if (typeof data === 'string') text = data
  else text = JSON.stringify(data, null, 0)
  const c = clip(text, MAX_RESULT_CHARS)
  return c.truncated
    ? `${c.text}\n[结果过大被截断：请改用 category/volume 过滤、offset/limit 分页、detail=summary 或按 id 逐条读取后重试，勿基于截断数据下全局结论]`
    : c.text
}

/** 恢复工具参数：解开历史遗留/模型模仿的 _raw 包裹；解不开的按解析失败处理（绝不让 _raw 回灌历史） */
export function recoverCalls<
  T extends { id: string; name: string; input: ToolInput; inputError?: 'truncated' | 'invalid' }
>(calls: T[]): T[] {
  for (const tu of calls) {
    if (tu.inputError) {
      tu.input = {}
      continue
    }
    const rec = recoverToolInput(tu.input)
    tu.input = rec.ok ? rec.input : {}
    if (!rec.ok) tu.inputError = 'invalid'
  }
  return calls
}

/** 危险判定：删除类硬标 + dangerCheck 动态复核（参数不合法时交给 handler 报错） */
export function dangerOf(tool: AgentTool, input: ToolInput, projectId: string): string | null {
  let reason: string | null = null
  if (tool.danger) reason = '删除操作不可恢复'
  if (tool.dangerCheck) {
    try {
      reason = tool.dangerCheck(input, projectId) ?? reason
    } catch {
      /* 参数不合法时交给 handler 报错 */
    }
  }
  return reason
}

export interface ExecDeps {
  toolMap: Map<string, AgentTool>
  projectId: string
  /** 只读工具集合：不计入 changed 标记 */
  readTools: ReadonlySet<string>
  emitToolCall: (call: AgentToolCallEvent) => void
  emitToolResult: (ev: AgentToolResultEvent) => void
  /** danger 命中且不在 always 白名单时触发；resolve true 放行（缺省视为拒绝） */
  confirm?: (call: AgentToolCallEvent) => Promise<boolean>
  /** 本 run 的「总是允许」工具白名单（命中则跳过确认流） */
  isAlwaysAllowed?: (toolName: string) => boolean
  /** execCtx 类工具（spawn_subagent）的执行上下文（含 projectId/usage/signal 等，parentId 由 executor 补） */
  execCtxBase?: Omit<ToolExecContext, 'parentId'>
  subagentBudget?: { used: number; max: number }
}

export interface ExecOutcome {
  resultBlocks: ContentBlock[]
  toolResults: AgentToolResultEvent[]
  toolUseCount: number
  changed: boolean
  denied: boolean
}

interface ToolCall {
  id: string
  name: string
  input: ToolInput
  inputError?: 'truncated' | 'invalid'
}

/** 单个调用的结果落账槽位：按调用序归位（resultBlocks 顺序与 assistant tool_use 一致） */
interface ResultSlot {
  block: ContentBlock
  ev: AgentToolResultEvent
}

/**
 * 单轮内的工具调用执行：连续只读调用聚批并发，写/确认/短路调用为串行点。
 * 分段保序：running 卡按调用序发（UI 卡序=模型调用序）、toolResult 事件按完成序发
 * （transcript 按 id 配对不受完成序影响）、resultBlocks 按调用序归位。
 * 短路件（未知工具/参数错误）同步落账，会打断并发批（异常路径，不值得为它保批）。
 */
export async function executeToolCalls(calls: ToolCall[], deps: ExecDeps): Promise<ExecOutcome> {
  const { toolMap, projectId, readTools, emitToolCall, emitToolResult, confirm } = deps
  const slots: ResultSlot[] = new Array(calls.length)
  let changed = false
  let denied = false

  const settle = (index: number, block: ContentBlock, ev: AgentToolResultEvent): void => {
    slots[index] = { block, ev }
    emitToolResult(ev)
  }

  const shortCircuit = (
    index: number,
    id: string,
    msg: string,
    opts?: { denied?: boolean }
  ): void => {
    const ev: AgentToolResultEvent = { id, ok: false, result: msg }
    if (opts?.denied) ev.denied = true
    settle(index, { type: 'tool_result', tool_use_id: id, content: msg, is_error: true }, ev)
  }

  /** 可并发时返回工具引用（调用与工具绑定，免去二次查表）；不可并发（不存在/参数错/委派/非只读/危险）返回 null */
  const batchableTool = (tu: ToolCall): AgentTool | null => {
    const tool = toolMap.get(tu.name)
    if (!tool || tu.inputError || tool.execCtx) return null
    if (!readTools.has(tu.name)) return null
    // 只读工具按定义无 danger，这里防御性复核（误标只读的写工具绝不能并发）
    return dangerOf(tool, tu.input, projectId) === null ? tool : null
  }

  /** 执行单个已放行调用（并发批与串行点共用）；完成即落槽+发事件 */
  const runOne = async (tu: ToolCall, tool: AgentTool, index: number): Promise<void> => {
    let ok: boolean
    let out: string
    try {
      if (tool.execCtx) {
        if (!deps.execCtxBase) throw new Error('当前上下文不支持委派子智能体')
        if (deps.subagentBudget) {
          if (deps.subagentBudget.used >= deps.subagentBudget.max) {
            throw new Error('已达到本次任务的子智能体委派上限，请自行完成剩余工作并总结')
          }
          deps.subagentBudget.used++
        }
        out = serializeResult(
          await tool.execCtx(tu.input, { ...deps.execCtxBase, parentId: tu.id })
        )
        ok = true
      } else {
        out = serializeResult(await tool.handler(tu.input, projectId))
        ok = true
      }
      if (!readTools.has(tu.name) && tu.name !== 'spawn_subagent') changed = true
    } catch (err) {
      out = `错误: ${(err as Error)?.message ?? String(err)}`
      ok = false
    }
    settle(
      index,
      { type: 'tool_result', tool_use_id: tu.id, content: out, is_error: ok ? undefined : true },
      { id: tu.id, ok, result: out }
    )
  }

  for (let i = 0; i < calls.length; ) {
    const tu = calls[i]

    const first = batchableTool(tu)
    if (first) {
      const batch: { tu: ToolCall; tool: AgentTool }[] = [{ tu, tool: first }]
      let j = i + 1
      for (; j < calls.length; j++) {
        const tool = batchableTool(calls[j])
        if (!tool) break
        batch.push({ tu: calls[j], tool })
      }
      // running 卡按调用序发，批内并发执行、结果按完成序发
      for (const b of batch) {
        emitToolCall({ id: b.tu.id, name: b.tu.name, input: b.tu.input, state: 'running' })
      }
      await Promise.all(batch.map((b, k) => runOne(b.tu, b.tool, i + k)))
      i = j
      continue
    }

    const tool = toolMap.get(tu.name)
    if (!tool) {
      shortCircuit(i, tu.id, `错误: 未知工具 ${tu.name}`)
      i++
      continue
    }

    if (tu.inputError) {
      const why =
        tu.inputError === 'truncated' ? '工具参数输出被长度上限截断' : '工具参数 JSON 不完整或非法'
      emitToolCall({ id: tu.id, name: tu.name, input: tu.input, state: 'running' })
      shortCircuit(
        i,
        tu.id,
        `错误: ${why}，本次调用未执行、未产生任何修改。请重新调用 ${tu.name}：参数内容过长时请精简或分批，并确保参数为完整合法的 JSON`
      )
      i++
      continue
    }

    const dangerReason = dangerOf(tool, tu.input, projectId)
    if (dangerReason && !(deps.isAlwaysAllowed?.(tu.name) ?? false)) {
      const call: AgentToolCallEvent = {
        id: tu.id,
        name: tu.name,
        input: tu.input,
        state: 'confirming',
        dangerReason
      }
      emitToolCall(call)
      const allowed = confirm ? await confirm(call) : false
      if (!allowed) {
        denied = true
        shortCircuit(i, tu.id, '用户拒绝了该操作', { denied: true })
        i++
        continue
      }
    } else {
      // 无需确认的调用才发 running 卡；danger 确认放行后维持 confirming 卡（transcript 同 id 仅一卡）
      emitToolCall({ id: tu.id, name: tu.name, input: tu.input, state: 'running' })
    }

    await runOne(tu, tool, i)
    i++
  }

  const toolResults = slots.map((s) => s.ev)
  const resultBlocks = slots.map((s) => s.block)
  return { resultBlocks, toolResults, toolUseCount: calls.length, changed, denied }
}
