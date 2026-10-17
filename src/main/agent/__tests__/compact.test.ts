import { describe, expect, it } from 'vitest'
import type { ChatMessage, ContentBlock } from '../../../shared/types'
import { buildAutoCompact, createCompactPolicy, groupMessages, msgSize } from '../policy/compact'

const tu = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input
})

const tr = (id: string, content: string): ContentBlock => ({
  type: 'tool_result',
  tool_use_id: id,
  content
})

describe('groupMessages 原子组切割', () => {
  it('assistant 与紧随的 tool_result user 绑成一组', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '任务' },
      { role: 'assistant', content: [tu('a1', 'list_projects')] },
      { role: 'user', content: [tr('a1', 'ok')] },
      { role: 'assistant', content: '完成' }
    ]
    const groups = groupMessages(msgs)
    expect(groups).toHaveLength(3)
    expect(groups[1].msgs).toHaveLength(2)
    expect(groups[1].toolNames).toEqual(['list_projects'])
    expect(groups[2].msgs).toHaveLength(1)
  })

  it('连续 assistant 无 tool_result 时各自独立成组', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: 'a' },
      { role: 'assistant', content: 'b' }
    ]
    expect(groupMessages(msgs)).toHaveLength(2)
  })

  it('普通 user 消息独立成组', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: '追加指令' }]
    const groups = groupMessages(msgs)
    expect(groups).toHaveLength(1)
    expect(groups[0].toolNames).toEqual([])
  })
})

describe('buildAutoCompact 压缩预算', () => {
  const bigResult = 'x'.repeat(500)

  it('保留区不超预算且至少保留最后一组', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '写一本书' },
      { role: 'assistant', content: [tu('a1', 'list_projects')] },
      { role: 'user', content: [tr('a1', bigResult)] }
    ]
    const { summary, kept } = buildAutoCompact(msgs, 100)
    expect(kept.length).toBeGreaterThanOrEqual(2)
    expect(kept.length).toBeLessThan(msgs.length)
    expect(summary).toContain('写一本书')
    expect(summary).toContain('已省略早期')
  })

  it('继承前次压缩摘要头', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '【上下文压缩】旧摘要' },
      { role: 'assistant', content: [tu('a1', 'list_projects')] },
      { role: 'user', content: [tr('a1', bigResult)] }
    ]
    const { summary } = buildAutoCompact(msgs, 100)
    expect(summary).toContain('前次压缩摘要（继承')
  })

  it('丢弃组统计工具调用次数', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '任务' },
      { role: 'assistant', content: [tu('a1', 'list_projects'), tu('a2', 'list_projects')] },
      { role: 'user', content: [tr('a1', bigResult), tr('a2', bigResult)] },
      { role: 'assistant', content: [tu('a3', 'get_outline')] },
      { role: 'user', content: [tr('a3', bigResult)] }
    ]
    const { summary } = buildAutoCompact(msgs, 120)
    expect(summary).toContain('list_projects×2')
    expect(summary).not.toContain('get_outline×1')
  })

  it('消息尺寸粗估覆盖三种 block', () => {
    const m: ChatMessage = {
      role: 'assistant',
      content: [tu('a1', 't', { k: 'v' })]
    }
    expect(msgSize(m)).toBeGreaterThan(40)
  })
})

describe('compact policy', () => {
  const makePolicy = (window: number, messages: ChatMessage[] = []) =>
    createCompactPolicy({
      counters: { autoContinues: 0, autoCompacts: 0, compacted: false, compactSummary: '' },
      messages,
      contextWindow: window,
      emitToolCall: () => {},
      emitToolResult: () => {}
    })

  it('appendNudge 超阈值时在最后一个 tool_result 追加提示', () => {
    const policy = makePolicy(1000)
    const blocks: ContentBlock[] = [tr('a1', '结果')]
    policy.appendNudge(blocks, 700)
    expect((blocks[0] as { content: string }).content).toContain('[系统提示')
  })

  it('appendNudge 未超阈值不追加', () => {
    const policy = makePolicy(1000)
    const blocks: ContentBlock[] = [tr('a1', '结果')]
    policy.appendNudge(blocks, 100)
    expect((blocks[0] as { content: string }).content).toBe('结果')
  })

  it('onContextTooLong 非超限错误不处理', () => {
    const policy = makePolicy(1000)
    expect(policy.onContextTooLong(new Error('network down'), new AbortController().signal)).toBe(
      false
    )
  })

  it('afterTurn 未达窗口比例不压缩', () => {
    const policy = makePolicy(1000)
    expect(policy.afterTurn(100, 100, true, new AbortController().signal)).toBe(false)
  })
})
