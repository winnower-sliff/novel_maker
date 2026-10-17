import { describe, expect, it, vi } from 'vitest'
import type { AgentToolCallEvent, AgentToolResultEvent } from '../../../shared/contract'
import type { ContentBlock } from '../../../shared/types'
import { dangerOf, executeToolCalls, recoverCalls, serializeResult } from '../executor'
import type { AgentTool } from '../toolkit'

const okTool = (name: string, opts: Partial<AgentTool> = {}): AgentTool => ({
  def: { name, description: name, input_schema: { type: 'object', properties: {}, required: [] } },
  danger: false,
  handler: () => 'ok',
  ...opts
})

const call = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  id,
  name,
  input
})

const deps = (over: Partial<Parameters<typeof executeToolCalls>[1]> = {}) => ({
  toolMap: new Map<string, AgentTool>(),
  projectId: 'p1',
  readTools: new Set<string>(['read_tool']),
  emitToolCall: (_c: AgentToolCallEvent) => {},
  emitToolResult: (_e: AgentToolResultEvent) => {},
  ...over
})

describe('serializeResult 截断', () => {
  it('超限截断并附补救指引', () => {
    const out = serializeResult('x'.repeat(30001))
    expect(out).toContain('已截断')
    expect(out).toContain('分页')
  })

  it('未超限原样返回', () => {
    expect(serializeResult('短结果')).toBe('短结果')
  })

  it('对象序列化', () => {
    expect(serializeResult({ a: 1 })).toContain('"a"')
  })
})

describe('recoverCalls 参数恢复', () => {
  type Call = {
    id: string
    name: string
    input: Record<string, unknown>
    inputError?: 'truncated' | 'invalid'
  }

  it('解开 _raw 包裹', () => {
    const calls: Call[] = [{ id: 'a', name: 't', input: { _raw: '{"x":1}' } }]
    const out = recoverCalls(calls)
    expect(out[0].input).toEqual({ x: 1 })
    expect(out[0].inputError).toBeUndefined()
  })

  it('解不开标记 invalid 并清空 input', () => {
    const calls: Call[] = [{ id: 'a', name: 't', input: { _raw: '{invalid' } }]
    const out = recoverCalls(calls)
    expect(out[0].input).toEqual({})
    expect(out[0].inputError).toBe('invalid')
  })

  it('已有 inputError 保持清空', () => {
    const calls: Call[] = [{ id: 'a', name: 't', input: { x: 1 }, inputError: 'truncated' }]
    const out = recoverCalls(calls)
    expect(out[0].input).toEqual({})
  })
})

describe('dangerOf 危险判定', () => {
  it('danger 硬标删除不可恢复', () => {
    expect(dangerOf(okTool('del', { danger: true }), {}, 'p1')).toBe('删除操作不可恢复')
  })

  it('dangerCheck 覆盖默认理由', () => {
    const tool = okTool('save', {
      dangerCheck: () => '覆盖正文需确认'
    })
    expect(dangerOf(tool, {}, 'p1')).toBe('覆盖正文需确认')
  })

  it('dangerCheck 抛错不外溢', () => {
    const tool = okTool('save', {
      danger: true,
      dangerCheck: () => {
        throw new Error('bad param')
      }
    })
    expect(dangerOf(tool, {}, 'p1')).toBe('删除操作不可恢复')
  })
})

describe('executeToolCalls 串行执行', () => {
  it('按调用顺序执行并产出 tool_result blocks', async () => {
    const order: string[] = []
    const toolMap = new Map<string, AgentTool>([
      [
        't1',
        okTool('t1', {
          handler: () => {
            order.push('t1')
            return 'r1'
          }
        })
      ],
      [
        't2',
        okTool('t2', {
          handler: () => {
            order.push('t2')
            return 'r2'
          }
        })
      ]
    ])
    const outcome = await executeToolCalls([call('a', 't1'), call('b', 't2')], deps({ toolMap }))
    expect(order).toEqual(['t1', 't2'])
    expect(outcome.resultBlocks).toHaveLength(2)
    expect(outcome.resultBlocks[0]).toMatchObject({ tool_use_id: 'a', content: 'r1' })
    expect(outcome.toolUseCount).toBe(2)
    expect(outcome.changed).toBe(true)
  })

  it('未知工具短路报错', async () => {
    const outcome = await executeToolCalls([call('a', 'nope')], deps())
    expect(outcome.resultBlocks[0]).toMatchObject({ is_error: true })
    expect(
      outcome.resultBlocks[0].type === 'tool_result' && outcome.resultBlocks[0].content
    ).toContain('未知工具')
  })

  it('inputError 短路报错不执行 handler', async () => {
    const handler = vi.fn()
    const toolMap = new Map<string, AgentTool>([['t1', okTool('t1', { handler })]])
    const outcome = await executeToolCalls(
      [call('a', 't1', { x: 1 })].map((c) => ({ ...c, inputError: 'invalid' as const })),
      deps({ toolMap })
    )
    expect(handler).not.toHaveBeenCalled()
    expect(
      outcome.resultBlocks[0].type === 'tool_result' && outcome.resultBlocks[0].content
    ).toContain('JSON 不完整')
  })

  it('handler 抛错转为错误 tool_result', async () => {
    const toolMap = new Map<string, AgentTool>([
      [
        't1',
        okTool('t1', {
          handler: () => {
            throw new Error('boom')
          }
        })
      ]
    ])
    const outcome = await executeToolCalls([call('a', 't1')], deps({ toolMap }))
    const block = outcome.resultBlocks[0]
    expect(block.type === 'tool_result' && block.is_error).toBe(true)
    expect(outcome.toolResults[0].ok).toBe(false)
  })

  it('danger 工具确认拒绝：denied 标记且不执行', async () => {
    const handler = vi.fn()
    const toolMap = new Map<string, AgentTool>([['del', okTool('del', { danger: true, handler })]])
    const calls: AgentToolCallEvent[] = []
    const outcome = await executeToolCalls(
      [call('a', 'del')],
      deps({
        toolMap,
        emitToolCall: (c) => calls.push(c),
        confirm: async () => false
      })
    )
    expect(handler).not.toHaveBeenCalled()
    expect(outcome.denied).toBe(true)
    expect(outcome.toolResults[0].denied).toBe(true)
    expect(calls[0].state).toBe('confirming')
  })

  it('danger 工具确认放行后正常执行', async () => {
    const toolMap = new Map<string, AgentTool>([
      ['del', okTool('del', { danger: true, handler: () => 'deleted' })]
    ])
    const states: string[] = []
    const outcome = await executeToolCalls(
      [call('a', 'del')],
      deps({
        toolMap,
        emitToolCall: (c) => states.push(c.state),
        confirm: async () => true
      })
    )
    // 放行后不重发 running 卡（transcript 同 id 仅一卡，重复会投影出双卡）
    expect(states).toEqual(['confirming'])
    expect(outcome.resultBlocks[0].type === 'tool_result' && outcome.resultBlocks[0].content).toBe(
      'deleted'
    )
  })

  it('confirm 缺省时 danger 工具按拒绝处理', async () => {
    const toolMap = new Map<string, AgentTool>([
      ['del', okTool('del', { danger: true, handler: () => 'x' })]
    ])
    const outcome = await executeToolCalls([call('a', 'del')], deps({ toolMap }))
    expect(outcome.denied).toBe(true)
  })

  it('只读工具不计 changed', async () => {
    const toolMap = new Map<string, AgentTool>([['read_tool', okTool('read_tool')]])
    const outcome = await executeToolCalls([call('a', 'read_tool')], deps({ toolMap }))
    expect(outcome.changed).toBe(false)
  })

  it('execCtx 工具走上下文执行并受预算约束', async () => {
    const execCtx = async () => 'sub-report'
    const toolMap = new Map<string, AgentTool>([
      ['spawn_subagent', okTool('spawn_subagent', { execCtx })]
    ])
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
    const base = {
      sink: { isClosed: () => true, send: () => {} },
      requestId: 'r1',
      projectId: 'p1',
      usage,
      signal: new AbortController().signal,
      model: 'm',
      apiKey: 'k',
      baseUrl: 'http://x',
      protocol: 'anthropic' as const,
      promptCache: false
    }
    const outcome = await executeToolCalls(
      [call('a', 'spawn_subagent')],
      deps({
        toolMap,
        execCtxBase: base,
        subagentBudget: { used: 0, max: 1 }
      })
    )
    expect(outcome.resultBlocks[0].type === 'tool_result' && outcome.resultBlocks[0].content).toBe(
      'sub-report'
    )

    const full = await executeToolCalls(
      [call('b', 'spawn_subagent')],
      deps({
        toolMap,
        execCtxBase: base,
        subagentBudget: { used: 1, max: 1 }
      })
    )
    expect(full.resultBlocks[0].type === 'tool_result' && full.resultBlocks[0].is_error).toBe(true)
  })

  it('tool_result 与事件流水一致', async () => {
    const toolMap = new Map<string, AgentTool>([['t1', okTool('t1')]])
    const events: AgentToolResultEvent[] = []
    const outcome = await executeToolCalls(
      [call('a', 't1')],
      deps({
        toolMap,
        emitToolResult: (e) => events.push(e)
      })
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(outcome.toolResults[0])
    expect((outcome.resultBlocks[0] as ContentBlock).type).toBe('tool_result')
  })
})

describe('executeToolCalls 只读并发分段', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

  const readTool = (name: string, ms: number, marks?: string[]): AgentTool =>
    okTool(name, {
      handler: async () => {
        marks?.push(`${name}:start`)
        await delay(ms)
        marks?.push(`${name}:end`)
        return `${name}-result`
      }
    })

  it('连续只读调用并发执行，结果按调用序归位', async () => {
    const marks: string[] = []
    const toolMap = new Map<string, AgentTool>([
      ['slow_read', readTool('slow_read', 40, marks)],
      ['fast_read', readTool('fast_read', 1, marks)]
    ])
    const events: AgentToolResultEvent[] = []
    const outcome = await executeToolCalls(
      [call('a', 'slow_read'), call('b', 'fast_read')],
      deps({
        toolMap,
        readTools: new Set(['slow_read', 'fast_read']),
        emitToolResult: (e) => events.push(e)
      })
    )
    // 并发：fast 在 slow 结束前启动并完成（若串行 fast:end 必在 slow:end 之后）
    expect(marks.indexOf('fast_read:end')).toBeLessThan(marks.indexOf('slow_read:end'))
    // resultBlocks 与 toolResults 按调用序（a 在前），事件流按完成序（b 在前）
    expect(
      outcome.resultBlocks.map((b) => (b.type === 'tool_result' ? b.tool_use_id : ''))
    ).toEqual(['a', 'b'])
    expect(outcome.toolResults.map((e) => e.id)).toEqual(['a', 'b'])
    expect(events.map((e) => e.id)).toEqual(['b', 'a'])
    expect(outcome.changed).toBe(false)
  })

  it('写工具是串行点：批先收尾再执行写', async () => {
    const marks: string[] = []
    const toolMap = new Map<string, AgentTool>([
      ['r1', readTool('r1', 30, marks)],
      [
        'w1',
        okTool('w1', {
          handler: () => {
            marks.push('w1:start')
            return 'wrote'
          }
        })
      ]
    ])
    await executeToolCalls(
      [call('a', 'r1'), call('b', 'w1')],
      deps({ toolMap, readTools: new Set(['r1']) })
    )
    expect(marks).toEqual(['r1:start', 'r1:end', 'w1:start'])
  })

  it('混合序列分段：读-写-读 各段保序', async () => {
    const marks: string[] = []
    const toolMap = new Map<string, AgentTool>([
      ['r1', readTool('r1', 20, marks)],
      [
        'w1',
        okTool('w1', {
          handler: () => {
            marks.push('w1:start')
            return 'wrote'
          }
        })
      ],
      ['r2', readTool('r2', 20, marks)]
    ])
    const outcome = await executeToolCalls(
      [call('a', 'r1'), call('b', 'w1'), call('c', 'r2')],
      deps({ toolMap, readTools: new Set(['r1', 'r2']) })
    )
    expect(marks.indexOf('w1:start')).toBeGreaterThan(marks.indexOf('r1:end'))
    expect(marks.indexOf('r2:start')).toBeGreaterThan(marks.indexOf('w1:start'))
    expect(outcome.changed).toBe(true)
  })

  it('误标只读的危险工具不进并发批，走确认流串行', async () => {
    const handler = vi.fn(() => 'done')
    const toolMap = new Map<string, AgentTool>([
      ['danger_read', okTool('danger_read', { danger: true, handler })]
    ])
    const callsEv: AgentToolCallEvent[] = []
    const outcome = await executeToolCalls(
      [call('a', 'danger_read'), call('b', 'danger_read')],
      deps({ toolMap, emitToolCall: (c) => callsEv.push(c) })
    )
    // 确认缺省拒绝：两条都 denied 短路，handler 不执行
    expect(handler).not.toHaveBeenCalled()
    expect(outcome.denied).toBe(true)
    expect(callsEv.every((c) => c.state === 'confirming')).toBe(true)
  })

  it('未知工具混在只读中间会打断批（各段仍正确落账）', async () => {
    const marks: string[] = []
    const toolMap = new Map<string, AgentTool>([
      ['r1', readTool('r1', 1, marks)],
      ['r2', readTool('r2', 1, marks)]
    ])
    const outcome = await executeToolCalls(
      [call('a', 'r1'), call('x', 'nope'), call('c', 'r2')],
      deps({ toolMap, readTools: new Set(['r1', 'r2']) })
    )
    expect(marks).toContain('r1:start')
    expect(marks).toContain('r2:start')
    expect(outcome.resultBlocks).toHaveLength(3)
    expect(outcome.resultBlocks[1]).toMatchObject({ is_error: true })
    expect(outcome.toolUseCount).toBe(3)
  })
})
