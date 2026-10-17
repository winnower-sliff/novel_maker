import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageInfo } from '../../../shared/types'
import type { LoopEmit } from '../loop'
import { runLoop } from '../loop'
import { createLoopCounters } from '../policy/compact'
import { createContinuePolicy } from '../policy/continue'
import type { AgentTool } from '../toolkit'

// chatStream/appendUsage 有真实副作用（网络/账本文件），骨架组合测试一律 mock
// （vi.mock 路径相对本测试文件解析，指向 src/main/{llm,usage}，与 loop.ts 内的引用是同一模块）
vi.mock('../../llm', () => ({ chatStream: vi.fn(), pickRatelimitHeaders: vi.fn(() => ({})) }))
vi.mock('../../usage', () => ({ appendUsage: vi.fn() }))

const { chatStream } = await import('../../llm')
const chatStreamMock = vi.mocked(chatStream)

const noopEmit: LoopEmit = { delta: () => {}, toolCall: () => {}, toolResult: () => {} }
const usage = (): UsageInfo => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0
})

const noopTool: AgentTool = {
  def: { name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } },
  danger: false,
  handler: () => 'ok'
}

const baseConfig = () => ({
  system: 'sys',
  tools: [noopTool.def],
  toolMap: new Map([['noop', noopTool]]),
  readTools: new Set<string>(['noop']),
  projectId: 'p1',
  model: 'test-model',
  maxTokens: 100,
  promptCache: false,
  apiKey: 'k',
  baseUrl: 'http://x',
  protocol: 'anthropic' as const,
  maxTurns: 24,
  signal: new AbortController().signal
})

// 纯文本轮：无工具调用（触发 onStop 判定）
const plainText = (text: string) => ({
  text,
  toolUses: [],
  usage: usage(),
  model: 'test-model',
  durationMs: 1,
  headers: {},
  stopReason: 'end_turn' as const
})

// 工具轮：做一次实际工作，让 toolUseCount>0（looksLikePaused 的前置条件）
const toolTurn = () => ({
  text: '',
  toolUses: [{ id: 't1', name: 'noop', input: {} }],
  usage: usage(),
  model: 'test-model',
  durationMs: 1,
  headers: {},
  stopReason: 'tool_use' as const
})

beforeEach(() => {
  chatStreamMock.mockReset()
})

describe('runLoop 骨架与续跑策略组合', () => {
  it('疑似停摆时注入续跑消息，计数仅 +1（骨架不重复计）', async () => {
    chatStreamMock
      .mockImplementationOnce(async () => toolTurn())
      .mockResolvedValueOnce(plainText('是否需要我继续？'))
      .mockResolvedValueOnce(plainText('任务已全部完成。'))
    const counters = createLoopCounters()
    const result = await runLoop([{ role: 'user', content: '干活' }], baseConfig(), {
      emit: noopEmit,
      usage: usage(),
      counters,
      onStop: createContinuePolicy(counters).onStop
    })
    expect(chatStreamMock).toHaveBeenCalledTimes(3)
    expect(result.autoContinues).toBe(1)
    expect(result.text).toBe('任务已全部完成。')
  })

  it('续跑预算用尽后停止，总请求数 = 2 + MAX_AUTO_CONTINUES', async () => {
    // 首轮工具（建立 toolUseCount），之后全是征询语文本：续跑 2 次预算用尽后收尾
    chatStreamMock
      .mockImplementationOnce(async () => toolTurn())
      .mockResolvedValue(plainText('是否继续？'))
    const counters = createLoopCounters()
    const result = await runLoop([{ role: 'user', content: '干活' }], baseConfig(), {
      emit: noopEmit,
      usage: usage(),
      counters,
      onStop: createContinuePolicy(counters).onStop
    })
    expect(result.autoContinues).toBe(2)
    expect(result.requests).toBe(4)
  })
})
