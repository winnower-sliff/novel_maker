import { afterEach, describe, expect, it, vi } from 'vitest'
import { DELETE_TOOLS } from '../plan'
import {
  acquireSlot,
  releaseSlot,
  resetConcurrencyForTest,
  runSubAgent,
  withWriteLock,
  writableSubTools
} from '../subagent'
import type { AgentTool } from '../toolkit'
import { MAX_PARALLEL_SUBAGENTS } from '../toolkit'

vi.mock('../loop', () => ({ runLoop: vi.fn() }))
vi.mock('../../store', () => ({
  listProjects: () => [{ id: 'p1', title: '测试项目', genre: '', styleGuide: '' }]
}))
vi.mock('../instructions', () => ({ coreWritingRules: () => '', projectCoreRules: () => '' }))

afterEach(() => {
  resetConcurrencyForTest()
})

describe('writableSubTools 工具集组装', () => {
  it('不含删除类、spawn_subagent、propose_plan、compact_context', () => {
    const names = writableSubTools().map((t) => t.def.name)
    for (const d of DELETE_TOOLS) expect(names).not.toContain(d)
    expect(names).not.toContain('spawn_subagent')
    expect(names).not.toContain('propose_plan')
    expect(names).not.toContain('compact_context')
    // 写工具与看板自查所需工具保留（boardTools 由调用方合并）
    expect(names).toContain('save_chapter')
    expect(names).toContain('save_character')
  })
})

describe('acquireSlot 并发上限', () => {
  it('并发达到上限后等待，释放后放行', async () => {
    const signal = new AbortController().signal
    for (let i = 0; i < MAX_PARALLEL_SUBAGENTS; i++) await acquireSlot(signal)

    let acquired = 0
    const fourth = acquireSlot(signal).then(() => acquired++)
    await vi.waitFor(() => {
      // 第四个委派必须处于等待态（未完成）
      expect(acquired).toBe(0)
    })
    releaseSlot()
    await fourth
    expect(acquired).toBe(1)
  })

  it('已中止的 signal 立即抛错', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(acquireSlot(ctrl.signal)).rejects.toThrow('任务已中止')
  })

  it('等待中的委派在 signal 中止时立即失败并让出等待队列', async () => {
    const ctrl = new AbortController()
    const signal = new AbortController().signal
    for (let i = 0; i < MAX_PARALLEL_SUBAGENTS; i++) await acquireSlot(signal)
    const waiting = acquireSlot(ctrl.signal)
    ctrl.abort()
    await expect(waiting).rejects.toThrow('任务已中止')
    // 让出一个槽后，后续委派可正常获得（中止者未占用槽位）
    releaseSlot()
    await acquireSlot(new AbortController().signal)
  })
})

describe('withWriteLock 写互斥', () => {
  it('可写子代理串行执行（完成一个再下一个），前错不阻塞后', async () => {
    const marks: string[] = []
    const job =
      (name: string, ms: number, fail = false) =>
      async () => {
        marks.push(`${name}:start`)
        await new Promise((r) => setTimeout(r, ms))
        if (fail) throw new Error(`boom-${name}`)
        marks.push(`${name}:end`)
        return name
      }
    const r3 = withWriteLock(job('c', 1, true)).catch((e: Error) => e.message)
    const [r1, r2, c] = await Promise.all([
      withWriteLock(job('a', 30)),
      withWriteLock(job('b', 1)),
      r3
    ])
    expect(r1).toBe('a')
    expect(r2).toBe('b')
    expect(c).toBe('boom-c')
    // 严格互斥：start 与 end 交替（b 的 start 必须在 a 的 end 之后）
    expect(marks.indexOf('b:start')).toBeGreaterThan(marks.indexOf('a:end'))
  })
})

describe('runSubAgent 组装（F1 防回归：子代理 hooks 必带 execCtxBase）', () => {
  const loopResult = {
    text: 'ok',
    turns: 1,
    requests: 1,
    toolUseCount: 0,
    changed: false,
    denied: false,
    hitLimit: false,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    model: 'm',
    autoContinues: 0,
    autoCompacts: 0,
    compacted: false,
    compactSummary: '',
    toolResults: []
  }
  const boardTool = (name: string): AgentTool => ({
    def: { name, description: '', input_schema: { type: 'object', properties: {} } },
    danger: false,
    handler: () => ''
  })
  const ctx = {
    sink: { send: () => {}, isClosed: () => false },
    requestId: 'r1',
    parentId: 'p-root',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    signal: new AbortController().signal,
    projectId: 'p1',
    sessionId: 's1',
    model: 'm',
    apiKey: 'k',
    baseUrl: 'u',
    protocol: 'anthropic' as const,
    promptCache: false
  }

  it('write 模式：execCtxBase 含 sessionId/planPhase/boardTools，工具集合并看板工具', async () => {
    const { runLoop } = await import('../loop')
    const captured: Array<{
      config: Parameters<typeof runLoop>[1]
      hooks: Parameters<typeof runLoop>[2]
    }> = []
    vi.mocked(runLoop).mockImplementation(async (_m, config, h) => {
      captured.push({ config, hooks: h })
      return { ...loopResult }
    })
    const boardTools = new Map([
      ['get_board', boardTool('get_board')],
      ['update_board', boardTool('update_board')]
    ])
    const r = await runSubAgent({ ...ctx, task: 't', role: '', writeMode: true, boardTools })
    expect(r.report).toBe('ok')
    const { config, hooks: h } = captured[0]
    expect(h.execCtxBase).toBeDefined()
    expect(h.execCtxBase?.sessionId).toBe('s1')
    expect(h.execCtxBase?.planPhase).toBe('exec')
    expect([...(h.execCtxBase?.boardTools?.keys() ?? [])]).toEqual(['get_board', 'update_board'])
    // 工具集含看板工具；writeGuard 已挂
    expect(config.toolMap.has('get_board')).toBe(true)
    expect(config.toolMap.has('update_board')).toBe(true)
    expect(h.writeGuard).toBeTypeOf('function')
  })

  it('read 模式：execCtxBase 存在但无 planPhase，工具集不含写工具', async () => {
    const { runLoop } = await import('../loop')
    const captured: Array<{
      config: Parameters<typeof runLoop>[1]
      hooks: Parameters<typeof runLoop>[2]
    }> = []
    vi.mocked(runLoop).mockImplementation(async (_m, config, h) => {
      captured.push({ config, hooks: h })
      return { ...loopResult }
    })
    await runSubAgent({ ...ctx, task: 't', role: '' })
    const { config, hooks: h } = captured[0]
    expect(h.execCtxBase).toBeDefined()
    expect(h.execCtxBase?.planPhase).toBeUndefined()
    expect(config.toolMap.has('save_character')).toBe(false)
    expect(h.writeGuard).toBeUndefined()
  })
})
