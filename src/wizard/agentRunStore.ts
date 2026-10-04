// 智能体运行态全局容器：切页/切后台不再断流。
// 事件订阅由 ensureAgentRuntime() 在两端 App 连接就绪后幂等安装（模块级，仅一次），
// Agent / AgentChat 只是 store 的视图：挂载时 syncProject(projectId) 对账即可，
// 卸载不影响事件处理与持久化。跨端风格对齐 writeRunStore（容器进 zustand，可变量留模块级）。
import type { AgentToolCallEvent, AgentToolResultEvent } from '@shared/contract'
import type {
  AgentDonePayload,
  AgentSession,
  AgentToolCall,
  AgentTurn,
  RuntimeSnapshot
} from '@shared/types'
import { create } from 'zustand'
import { makeSessionTitle, turnsToMessages } from '../renderer/src/lib/agentTurns'
import { setAgentUi } from '../renderer/src/lib/agentUiStore'
import { qk } from '../renderer/src/lib/queries'
import { queryClient } from '../renderer/src/lib/queryClient'
import { ensureBridge } from './ensureBridge'
import { pushToast } from './toastStore'

export interface SubProc {
  task: string
  role: string
  text: string
  tools: AgentToolCall[]
  running: boolean
}

interface AgentRunState {
  projectId: string | null
  requestId: string | null
  sessionId: string | null
  sessionCreatedAt: number
  turns: AgentTurn[]
  running: boolean
  error: string
  doneInfo: AgentDonePayload | null
  subProcs: Record<string, SubProc>
}

export const useAgentRunStore = create<AgentRunState>(() => ({
  projectId: null,
  requestId: null,
  sessionId: null,
  sessionCreatedAt: Date.now(),
  turns: [],
  running: false,
  error: '',
  doneInfo: null,
  subProcs: {}
}))

// —— 模块级可变结构：delta 缓冲（rAF 节流）与代际令牌（作废迟到的异步回包）——
let pendingDelta = ''
let rafId: number | null = null
/** run 代际：switchSession/syncProject/stop 递增，使迟到 run rid / sessionLoad 失效 */
let genToken = 0

function findConfirmTarget(s: AgentRunState): AgentToolCall | null {
  if (!s.running || s.turns.length === 0) return null
  const last = s.turns[s.turns.length - 1]
  if (last.role !== 'assistant') return null
  return last.toolCalls.find((c) => c.state === 'confirming') ?? null
}

/** 订阅确认目标（引用稳定：直接取 turns 内的 call 对象） */
export function useAgentConfirmTarget(): AgentToolCall | null {
  return useAgentRunStore(findConfirmTarget)
}

function finalizeTurns(turns: AgentTurn[]): AgentTurn[] {
  return turns.map((t) =>
    t.role === 'assistant'
      ? {
          ...t,
          toolCalls: t.toolCalls.map((c) =>
            c.state === 'running' || c.state === 'confirming'
              ? { ...c, state: 'error' as const, result: c.result ?? '（已中断）' }
              : c
          )
        }
      : t
  )
}

function patchLastAssistant(fn: (t: Extract<AgentTurn, { role: 'assistant' }>) => AgentTurn): void {
  const prev = useAgentRunStore.getState().turns
  if (prev.length === 0) return
  const last = prev[prev.length - 1]
  if (last.role !== 'assistant') return
  useAgentRunStore.setState({ turns: [...prev.slice(0, -1), fn(last)] })
}

function appendDelta(chunk: string): void {
  patchLastAssistant((t) => {
    const segments = t.segments ? [...t.segments] : [{ kind: 'text' as const, text: t.text }]
    const lastSeg = segments[segments.length - 1]
    if (lastSeg && lastSeg.kind === 'text')
      segments[segments.length - 1] = { kind: 'text', text: lastSeg.text + chunk }
    else segments.push({ kind: 'text', text: chunk })
    return { ...t, text: t.text + chunk, segments }
  })
}

function flushDelta(): void {
  rafId = null
  if (!pendingDelta) return
  const chunk = pendingDelta
  pendingDelta = ''
  appendDelta(chunk)
}

function scheduleFlush(): void {
  if (rafId === null) rafId = requestAnimationFrame(flushDelta)
}

export function cancelPendingDelta(): void {
  pendingDelta = ''
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

function persistSession(
  projectId: string,
  sid: string,
  createdAt: number,
  turns: AgentTurn[]
): void {
  const session: AgentSession = {
    id: sid,
    projectId,
    title: makeSessionTitle(turns),
    createdAt,
    updatedAt: Date.now(),
    turns
  }
  void window.api.agent
    .sessionSave(session)
    .then(() => {
      void queryClient.invalidateQueries({ queryKey: qk.agentSessions(projectId) })
    })
    .catch((err: unknown) => {
      console.warn('[agentRunStore] sessionSave failed:', err)
    })
}

function persistRun(): void {
  const s = useAgentRunStore.getState()
  if (!s.sessionId || !s.projectId) return
  persistSession(s.projectId, s.sessionId, s.sessionCreatedAt, s.turns)
}

export function startRun(input: string, model?: string): void {
  const s = useAgentRunStore.getState()
  if (!input.trim() || s.running || !s.projectId) return
  const projectId = s.projectId
  const sid = s.sessionId ?? crypto.randomUUID()
  const now = Date.now()
  const next: AgentTurn[] = [
    ...s.turns,
    { role: 'user', text: input.trim(), ts: now },
    { role: 'assistant', text: '', toolCalls: [], segments: [], ts: now }
  ]
  cancelPendingDelta()
  const token = ++genToken
  useAgentRunStore.setState({
    sessionId: sid,
    sessionCreatedAt: s.sessionId ? s.sessionCreatedAt : now,
    turns: next,
    running: true,
    error: '',
    doneInfo: null,
    subProcs: {},
    requestId: null
  })
  setAgentUi({ running: true, confirming: false, ended: null })
  // 先落一次库，防任务刚发出就关窗/刷新丢失用户消息
  persistRun()
  void window.api.agent
    .run({ projectId, messages: turnsToMessages(next), model })
    .then((id) => {
      if (token !== genToken) return
      useAgentRunStore.setState({ requestId: id })
    })
    .catch((err: unknown) => {
      if (token !== genToken) return
      useAgentRunStore.setState({ error: (err as Error).message, running: false })
      setAgentUi({ running: false, confirming: false, ended: { at: Date.now(), ok: false } })
    })
}

export function stopRun(): void {
  const { requestId } = useAgentRunStore.getState()
  genToken++
  if (requestId) void window.api.agent.abort(requestId)
}

export function resolveConfirm(allow: boolean, always: boolean): void {
  const s = useAgentRunStore.getState()
  const target = findConfirmTarget(s)
  if (!s.requestId || !target) return
  void window.api.agent.resolve(s.requestId, target.id, allow, always)
}

/** 切换/新建会话：运行中先停止（会话级显式操作，不做后台续跑） */
export function switchSession(id: string | null): void {
  const s = useAgentRunStore.getState()
  const token = ++genToken
  if (s.requestId) void window.api.agent.abort(s.requestId)
  cancelPendingDelta()
  setAgentUi({ running: false, confirming: false })
  useAgentRunStore.setState({
    requestId: null,
    running: false,
    error: '',
    doneInfo: null,
    subProcs: {},
    ...(id ? {} : { sessionId: null, sessionCreatedAt: Date.now(), turns: [] })
  })
  if (!id) return
  void window.api.agent.sessionLoad(id).then((session) => {
    if (token !== genToken || !session) return
    useAgentRunStore.setState({
      sessionId: session.id,
      sessionCreatedAt: session.createdAt,
      turns: session.turns
    })
  })
}

/**
 * 项目对账：同一项目重复调用是幂等 no-op（切页回来不重载、不打断后台任务）；
 * 项目变化才中断旧任务、落库旧会话并加载新项目最近会话。
 */
export function syncProject(projectId: string): void {
  const s = useAgentRunStore.getState()
  if (s.projectId === projectId) return
  const token = ++genToken
  if (s.requestId) void window.api.agent.abort(s.requestId)
  cancelPendingDelta()
  if (s.sessionId && s.projectId && s.turns.length > 0)
    persistSession(s.projectId, s.sessionId, s.sessionCreatedAt, finalizeTurns(s.turns))
  setAgentUi({ running: false, confirming: false })
  useAgentRunStore.setState({
    projectId: projectId || null,
    requestId: null,
    running: false,
    sessionId: null,
    sessionCreatedAt: Date.now(),
    turns: [],
    error: '',
    doneInfo: null,
    subProcs: {}
  })
  if (!projectId) return
  void window.api.agent
    .sessions(projectId)
    .then((list) => {
      if (token !== genToken || list.length === 0) return
      void window.api.agent.sessionLoad(list[0].id).then((session) => {
        if (token !== genToken || !session) return
        useAgentRunStore.setState({
          sessionId: session.id,
          sessionCreatedAt: session.createdAt,
          turns: session.turns
        })
      })
    })
    .catch((err: unknown) => {
      console.warn('[agentRunStore] syncProject load session failed:', err)
    })
}

/** 挂全局事件桥（幂等，两端 App 连接就绪后调用一次；与组件存活无关） */
export function ensureAgentRuntime(): void {
  ensureBridge('agentRun', () => {
    registerAgentSubEvents()

    window.api.agent.onDelta((id, text) => {
      const s = useAgentRunStore.getState()
      if (!s.running || id !== s.requestId) return
      pendingDelta += text
      scheduleFlush()
    })

    window.api.agent.onToolCall((id, call: AgentToolCallEvent) => {
      const s = useAgentRunStore.getState()
      if (!s.running || id !== s.requestId) return
      patchLastAssistant((t) => {
        const segments = t.segments ? [...t.segments] : [{ kind: 'text' as const, text: t.text }]
        segments.push({ kind: 'tool', callId: call.id })
        return {
          ...t,
          toolCalls: [
            ...t.toolCalls,
            {
              id: call.id,
              name: call.name,
              input: call.input,
              state: call.state,
              dangerReason: call.dangerReason
            }
          ],
          segments
        }
      })
      if (call.state === 'confirming') setAgentUi({ confirming: true })
    })

    window.api.agent.onToolResult((id, r: AgentToolResultEvent) => {
      const s = useAgentRunStore.getState()
      if (!s.running || id !== s.requestId) return
      patchLastAssistant((t) => ({
        ...t,
        toolCalls: t.toolCalls.map((c) =>
          c.id === r.id
            ? {
                ...c,
                state: (r.denied ? 'denied' : r.ok ? 'ok' : 'error') as AgentToolCall['state'],
                result: r.result
              }
            : c
        )
      }))
      setAgentUi({ confirming: false })
      flushDelta()
      persistRun()
    })

    window.api.agent.onDone((id, payload) => {
      applyAgentDone(id, payload)
    })

    window.api.agent.onError((id, message) => {
      applyAgentError(id, message)
    })
  })
}

/** 事件与同步器补拉共用收尾路径；id/running 守卫使二次应用幂等 */
export function applyAgentDone(id: string, payload: AgentDonePayload): boolean {
  const s = useAgentRunStore.getState()
  if (!s.running || id !== s.requestId) return false
  flushDelta()
  const fixed = finalizeTurns(useAgentRunStore.getState().turns)
  if (fixed.length > 0 && fixed[fixed.length - 1].role === 'assistant') {
    const last = fixed[fixed.length - 1] as Extract<AgentTurn, { role: 'assistant' }>
    fixed[fixed.length - 1] = { ...last, text: payload.text || last.text }
  }
  useAgentRunStore.setState({
    turns: fixed,
    running: false,
    requestId: null,
    doneInfo: payload
  })
  persistRun()
  setAgentUi({ running: false, confirming: false, ended: { at: Date.now(), ok: true } })
  return true
}

/** 事件与同步器补拉共用收尾路径；id/running 守卫使二次应用幂等 */
export function applyAgentError(id: string, message: string): boolean {
  const s = useAgentRunStore.getState()
  if (!s.running || id !== s.requestId) return false
  flushDelta()
  const fixed = finalizeTurns(useAgentRunStore.getState().turns)
  useAgentRunStore.setState({ turns: fixed, running: false, requestId: null, error: message })
  persistRun()
  setAgentUi({ running: false, confirming: false, ended: { at: Date.now(), ok: false } })
  return true
}

/** 中央同步器活跃判定：agent run 在途（含恢复绑定后的窗口期）计入 10s 活跃轮询 */
export function agentRunActive(): boolean {
  const s = useAgentRunStore.getState()
  return s.running && !!s.requestId
}

/**
 * runtime:snapshot 对账（中央同步器每 tick 调用）：
 * ① 在途补拉——done/error 事件丢失时从 runRecords 收尾并补通知
 * ② orphan 恢复——刷新/断连后 store 空而主进程仍在跑：绑定 rid 续流并重载运行会话；
 *    confirming 的 toolCall 不落会话文件，pendingConfirm 直取快照重建确认层
 */
export function syncAgentFromSnapshot(snap: RuntimeSnapshot): void {
  const s = useAgentRunStore.getState()

  if (s.running && s.requestId) {
    const rec = snap.runs.find((r) => r.id === s.requestId)
    if (rec?.status === 'done') {
      const payload = rec.donePayload as AgentDonePayload | undefined
      if (payload && applyAgentDone(rec.id, payload)) {
        pushToast('success', '后台智能体任务已完成')
      }
    } else if (rec?.status === 'error') {
      if (applyAgentError(rec.id, rec.error ?? '生成失败')) {
        pushToast('error', `后台智能体任务失败：${rec.error ?? '未知错误'}`)
      }
    }
    return
  }
  if (s.running || s.requestId) return

  const orphan = snap.runs.find(
    (r) => r.status === 'running' && r.kind === 'agent' && r.meta?.projectId
  )
  if (!orphan?.meta?.projectId) return
  const projectId = orphan.meta.projectId
  // 只在无项目上下文（刷新后）或同项目时接管；异项目不接管也不提示——
  // 接管后用户一切页 syncProject 就会按「项目变化」abort，误杀另一端正在跑的任务
  if (s.projectId !== null && s.projectId !== projectId) return
  const pending = orphan.pendingConfirm
  const token = ++genToken
  // 同项目且已有会话内容时直接在现有 turns 上绑定（syncProject 已加载过），否则清空走完整加载
  const keepTurns = s.projectId === projectId && s.turns.length > 0
  useAgentRunStore.setState({
    projectId,
    running: true,
    requestId: orphan.id,
    error: '',
    doneInfo: null,
    subProcs: {},
    ...(keepTurns ? {} : { sessionId: null, sessionCreatedAt: Date.now(), turns: [] })
  })
  setAgentUi({ running: true, confirming: !!pending })
  if (keepTurns) {
    rebuildPendingTurn(pending)
    return
  }
  void window.api.agent
    .sessions(projectId)
    .then((list) => {
      if (token !== genToken || list.length === 0) return
      void window.api.agent.sessionLoad(list[0].id).then((session) => {
        if (token !== genToken) return
        useAgentRunStore.setState({
          sessionId: session?.id ?? null,
          sessionCreatedAt: session?.createdAt ?? Date.now(),
          turns: session?.turns ?? []
        })
        rebuildPendingTurn(pending)
      })
    })
    .catch((err: unknown) => {
      console.warn('[agentRunStore] recover load session failed:', err)
    })
}

/** 把快照里的待应答确认重建为最后一个 assistant turn 的 confirming toolCall（幂等） */
function rebuildPendingTurn(pending: RuntimeSnapshot['runs'][number]['pendingConfirm']): void {
  if (!pending) return
  const s = useAgentRunStore.getState()
  if (!s.running || s.requestId === null) return
  const turns = s.turns
  const last = turns[turns.length - 1]
  if (last?.role !== 'assistant') return
  if (last.toolCalls.some((c) => c.id === pending.confirmId)) return
  useAgentRunStore.setState({
    turns: [
      ...turns.slice(0, -1),
      {
        ...last,
        toolCalls: [
          ...last.toolCalls,
          {
            id: pending.confirmId,
            name: pending.toolName,
            input: (typeof pending.input === 'object' && pending.input !== null
              ? pending.input
              : {}) as Record<string, unknown>,
            state: 'confirming' as const,
            dangerReason: pending.dangerReason
          }
        ]
      }
    ]
  })
}

/** onSubEvent 与回前台 flush 的注册体：由 ensureAgentRuntime 的 ensureBridge 回调调用 */
function registerAgentSubEvents(): void {
  window.api.agent.onSubEvent((id, ev) => {
    const s = useAgentRunStore.getState()
    if (!s.running || id !== s.requestId) return
    useAgentRunStore.setState((prev) => {
      const cur: SubProc = prev.subProcs[ev.parentId] ?? {
        task: '',
        role: '',
        text: '',
        tools: [],
        running: true
      }
      let next: SubProc
      switch (ev.type) {
        case 'start':
          next = { ...cur, task: ev.task, role: ev.role }
          break
        case 'delta':
          next = { ...cur, text: cur.text + ev.text }
          break
        case 'toolCall':
          next = { ...cur, tools: [...cur.tools, ev.call] }
          break
        case 'toolResult':
          next = {
            ...cur,
            tools: cur.tools.map((c) =>
              c.id === ev.id
                ? {
                    ...c,
                    state: (ev.ok ? 'ok' : 'error') as AgentToolCall['state'],
                    result: ev.result
                  }
                : c
            )
          }
          break
        case 'done':
          next = { ...cur, running: false, text: ev.text }
          break
        case 'error':
          next = { ...cur, running: false }
          break
      }
      return { subProcs: { ...prev.subProcs, [ev.parentId]: next } }
    })
  })

  // 页面从后台回前台：rAF 在后台被冻结，缓冲的 delta 立即刷入
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pendingDelta) flushDelta()
  })
}
