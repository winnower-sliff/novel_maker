import { describe, expect, it } from 'vitest'
import { createLoopCounters } from '../policy/compact'
import {
  createContinuePolicy,
  looksLikePaused,
  MAX_AUTO_CONTINUES,
  STOP_PHRASES
} from '../policy/continue'

describe('looksLikePaused 停摆判定', () => {
  it('无工具调用的纯问答不算停摆', () => {
    expect(looksLikePaused('是否继续？', 0, false)).toBe(false)
  })

  it('空文本不算', () => {
    expect(looksLikePaused('  ', 3, false)).toBe(false)
  })

  it('压缩后停顿直接判定停摆', () => {
    expect(looksLikePaused('好的', 3, true)).toBe(true)
  })

  it('疑问句结尾判定停摆', () => {
    expect(looksLikePaused('需要我继续吗？', 3, false)).toBe(true)
    expect(looksLikePaused('还要继续吗?', 3, false)).toBe(true)
  })

  it('征询语命中判定停摆', () => {
    expect(looksLikePaused('请指示下一步', 3, false)).toBe(true)
    expect(looksLikePaused('等待你的确认', 3, false)).toBe(true)
  })

  it('正常完成总结不算停摆', () => {
    expect(looksLikePaused('已完成全部修改，共更新 3 个条目。', 5, false)).toBe(false)
  })

  it('全部征询语正则可执行', () => {
    for (const re of STOP_PHRASES) {
      expect(() => re.test('x')).not.toThrow()
    }
  })
})

describe('createContinuePolicy 自动续跑预算', () => {
  it('命中停摆时返回注入文本并计数', () => {
    const counters = createLoopCounters()
    const policy = createContinuePolicy(counters)
    const inject = policy.onStop('是否继续？', 3, false)
    expect(inject).toContain('系统自动续跑')
    expect(counters.autoContinues).toBe(1)
  })

  it('未命中停摆返回 null', () => {
    const counters = createLoopCounters()
    const policy = createContinuePolicy(counters)
    expect(policy.onStop('任务完成。', 3, false)).toBeNull()
    expect(counters.autoContinues).toBe(0)
  })

  it('达 MAX_AUTO_CONTINUES 上限后不再续跑', () => {
    const counters = createLoopCounters()
    const policy = createContinuePolicy(counters)
    for (let i = 0; i < MAX_AUTO_CONTINUES; i++) {
      expect(policy.onStop('是否继续？', 3, false)).not.toBeNull()
    }
    expect(policy.onStop('是否继续？', 3, false)).toBeNull()
    expect(counters.autoContinues).toBe(MAX_AUTO_CONTINUES)
  })

  it('最后一次续跑注入用尽提示', () => {
    const counters = createLoopCounters()
    const policy = createContinuePolicy(counters)
    policy.onStop('是否继续？', 3, false)
    const last = policy.onStop('是否继续？', 3, false)
    expect(last).toContain('机会已用完')
  })
})
