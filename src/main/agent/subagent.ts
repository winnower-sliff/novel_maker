import type { ChatMessage, SubagentEvent } from '../../shared/types'
import * as store from '../store'
import { activeBoard } from './boards'
import { coreWritingRules, projectCoreRules } from './instructions'
import { runLoop } from './loop'
import { authorizeCall, DELETE_TOOLS } from './plan'
import { createLoopCounters } from './policy/compact'
import type { AgentTool } from './toolkit'
import {
  clip,
  MAX_PARALLEL_SUBAGENTS,
  MAX_SUB_TURNS,
  SUB_MAX_TOKENS,
  SUB_REPORT_CHARS,
  type ToolExecContext
} from './toolkit'
import { READ_TOOLS, SUB_TOOLS, TOOL_MAP } from './tools'

const EXCLUDED_FOR_WRITE = new Set([
  'spawn_subagent', // 子代理不嵌套委派（防递归爆炸）
  'propose_plan', // 提案权在主代理
  'compact_context' // 子代理上下文小，无自主压缩价值
])

function buildSubSystemPrompt(projectId: string, role: string, writeMode: boolean): string {
  const project = store.listProjects().find((p) => p.id === projectId)
  if (!project) throw new Error('项目不存在')
  const globalInstr = coreWritingRules().trim()
  const projectInstr = projectCoreRules(projectId).trim()
  const head = writeMode
    ? `你是小说项目《${project.title}》的子智能体（${role || '执行'}），由主智能体委派在计划授权范围内执行写入任务。`
    : `你是小说项目《${project.title}》的子智能体（${role || '通用调研'}），由主智能体委派执行只读调研/分析任务，为它的决策提供事实依据。`
  return [
    head,
    project.genre ? `类型：${project.genre}` : '',
    project.styleGuide ? `风格指南：${project.styleGuide}` : '',
    globalInstr && `用户全局指令（跨项目偏好，核心节）：\n${globalInstr}`,
    projectInstr && `本项目用户指令（最高优先级，与全局指令冲突时以本项目为准）：\n${projectInstr}`,
    '',
    '规则：',
    writeMode
      ? [
          '1. 你在主智能体计划批准的授权范围内工作：只写任务明确指向的目标（按 id 精确写入）；授权范围外的写入会被直接拒绝，不要尝试绕过',
          '2. 删除类工具不可用；遇到需要删除的场景，在报告中说明并交回主智能体',
          '3. save_summary/update_character_state/refresh_volume_summary 等系统附带更新无需授权可直接调用；写完章节后调用 lint_chapter 自检',
          '4. 独立完成任务，不要反问；完成后用 get_board 对照看板，用 update_board 把已完成步骤标记为 done（未完成则 in_progress）',
          '5. 最终报告精炼、结构化：写入了什么（目标 id/标题）、关键决定、遗留问题'
        ].join('\n')
      : [
          '1. 你只有只读工具，不能也不需要写入任何内容',
          '2. 独立完成任务，不要反问；信息不足以得出确定结论时，在报告中说明不确定性与缺失信息',
          '3. 全局范围的任务必须覆盖全部相关条目：按 total/hasMore/byCategory 分批读取直至读完，禁止基于不完整数据下结论',
          '4. 找主题相关内容优先 search_project，全书级问题先 get_book_digest',
          '5. 最终报告精炼、结构化：直接给结论，每条结论附证据（条目标题/人物名/章节号或原文短引），总长控制在 1500 字以内；不写过程流水账与客套话'
        ].join('\n')
  ]
    .filter(Boolean)
    .join('\n')
}

// —— 并发治理（模块级，跨主 run 的所有子代理共享） ——

let active = 0
const waiters: Array<() => void> = []

/** 并发槽（≤ MAX_PARALLEL_SUBAGENTS）；主 run 中止时等待中的委派立即失败 */
export async function acquireSlot(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('任务已中止')
  if (active < MAX_PARALLEL_SUBAGENTS) {
    active++
    return
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      const i = waiters.indexOf(wake)
      if (i >= 0) waiters.splice(i, 1)
      reject(new Error('任务已中止'))
    }
    const wake = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    waiters.push(wake)
  })
  active++
}

export function releaseSlot(): void {
  active--
  waiters.shift()?.()
}

/** 测试专用：复位模块级并发状态（进程内单例，测试间隔离用） */
export function resetConcurrencyForTest(): void {
  active = 0
  waiters.length = 0
  writeChain = Promise.resolve()
}

/** 子智能体与主代理共用 runLoop 骨架；差异（subEvent 包装、并发治理、写授权）在组装层吸收 */
// 可写子代理全局互斥：同一时间只有一个写子代理在跑（链式排队，前错不阻塞后）
let writeChain: Promise<void> = Promise.resolve()

export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn)
  writeChain = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

/** 可写子代理工具集：全部工具 − 删除类 − 排除项（调用方再合并 boardTools） */
export function writableSubTools(): AgentTool[] {
  return [...TOOL_MAP.values()].filter(
    (t) => !DELETE_TOOLS.has(t.def.name) && !EXCLUDED_FOR_WRITE.has(t.def.name)
  )
}

/** 子智能体与主代理共用 runLoop 骨架；差异（subEvent 包装、并发治理、写授权）在组装层吸收 */
export async function runSubAgent(
  ctx: ToolExecContext & {
    task: string
    role: string
    writeMode?: boolean
    /** 跨引擎委派时的鉴权覆盖（spawn_subagent model 参数经 resolveRequestAuth 解析） */
    authOverride?: {
      model: string
      apiKey: string
      baseUrl: string
      protocol: ToolExecContext['protocol']
      promptCache: boolean
    }
  }
): Promise<{ report: string; turns: number; changed: boolean }> {
  const { sink, requestId, parentId, usage, signal, task, role, writeMode, authOverride } = ctx
  const send = (ev: SubagentEvent): void => {
    if (!sink.isClosed()) sink.send('agent:subEvent', requestId, ev)
  }

  const auth = authOverride ?? {
    model: ctx.model,
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
    protocol: ctx.protocol,
    promptCache: ctx.promptCache
  }
  let tools: AgentTool[]
  let readTools: Set<string>
  if (writeMode) {
    const boardTools = ctx.boardTools ?? new Map<string, AgentTool>()
    tools = [...writableSubTools(), ...boardTools.values()]
    readTools = new Set([...READ_TOOLS, 'get_board', 'update_board'])
  } else {
    tools = SUB_TOOLS
    readTools = new Set(SUB_TOOLS.map((t) => t.def.name))
  }

  const execute = async (): Promise<{ report: string; turns: number; changed: boolean }> => {
    const system = buildSubSystemPrompt(ctx.projectId, role, !!writeMode)
    const messages: ChatMessage[] = [{ role: 'user', content: task }]
    send({ type: 'start', parentId, task, role })

    const toolMap = new Map(tools.map((t) => [t.def.name, t]))
    // 子代理 loop 的 execCtxBase：boardTools（get_board/update_board）是 execCtx 工具，
    // 缺它会在 executor 入口直接抛「当前上下文不支持委派」（F1 修复）
    const execCtxBase: Omit<ToolExecContext, 'parentId'> = {
      sink,
      requestId,
      usage,
      signal,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      model: auth.model,
      apiKey: auth.apiKey,
      baseUrl: auth.baseUrl,
      protocol: auth.protocol,
      promptCache: auth.promptCache,
      ...(writeMode ? { planPhase: 'exec' as const, boardTools: ctx.boardTools } : {})
    }
    const result = await runLoop(
      messages,
      {
        system,
        tools: tools.map((t) => t.def),
        toolMap,
        readTools,
        projectId: ctx.projectId,
        model: auth.model,
        maxTokens: SUB_MAX_TOKENS,
        promptCache: auth.promptCache,
        apiKey: auth.apiKey,
        baseUrl: auth.baseUrl,
        protocol: auth.protocol,
        maxTurns: MAX_SUB_TURNS,
        signal
      },
      {
        emit: {
          delta: (text) => send({ type: 'delta', parentId, text }),
          toolCall: (call) =>
            send({ type: 'toolCall', parentId, call: { ...call, state: 'running' } }),
          toolResult: (ev) =>
            send({ type: 'toolResult', parentId, id: ev.id, ok: ev.ok, result: ev.result })
        },
        usage,
        counters: createLoopCounters(),
        execCtxBase,
        ...(writeMode
          ? {
              writeGuard: (name: string, input: Record<string, unknown>): string | null => {
                const board = ctx.sessionId ? activeBoard(ctx.sessionId) : null
                const r = authorizeCall(name, input, board)
                return r.ok ? null : r.reason
              }
            }
          : {})
      }
    )

    const report = clip(
      result.hitLimit
        ? `${result.text}\n[达到子任务步数上限，以上为部分结论]`
        : result.text || '（子智能体未产出文本结论）',
      SUB_REPORT_CHARS
    ).text
    send({ type: 'done', parentId, text: report, turns: result.turns })
    return { report, turns: result.turns, changed: result.changed }
  }

  await acquireSlot(signal)
  try {
    return writeMode ? await withWriteLock(execute) : await execute()
  } finally {
    releaseSlot()
  }
}
