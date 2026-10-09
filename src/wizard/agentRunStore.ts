// 智能体运行态全局容器（事件投影版）：
// - 服务端 transcript 是唯一事实源：turns = eventsToTurns(events) 的投影，
//   SSE agent:transcript 实时追加（带 seq），断流/缺口经 agent:sessionEvents(afterSeq) 补拉。
// - 多会话并行：sessions map 维护每个已打开会话的缓冲（events/lastSeq/liveDelta/运行态），
//   activeId 仅决定镜像到顶层平面字段（兼容既有 UI 消费面）；切换/新建永不 abort 后台 run。
// - 事件订阅由 ensureAgentRuntime() 在两端 App 连接就绪后幂等安装（模块级，仅一次）。

import { eventsToTurns } from '@shared/agentTranscript'
import { classifyLlmError } from '@shared/llmError'
import type { ProviderId } from '@shared/providers'
import type {
  AgentDonePayload,
  AgentQueueItem,
  AgentToolCall,
  AgentTranscriptEvent,
  AgentTurn,
  LlmErrorHint,
  RuntimeSnapshot
} from '@shared/types'
import { create } from 'zustand'
import { setAgentUi } from '../renderer/src/lib/agentUiStore'
import { qk } from '../renderer/src/lib/queries'
import { queryClient } from '../renderer/src/lib/queryClient'
import { useAgentTabsStore } from './agentTabsStore'
import { ensureBridge } from './ensureBridge'
import { pushToast } from './toastStore'

export interface SubProc {
  task: string
  role: string
  text: string
  tools: AgentToolCall[]
  running: boolean
}

/** 单会话缓冲：服务端事件的本地投影材料 + 运行态 */
interface SessionBuf {
  id: string
  createdAt: number
  events: AgentTranscriptEvent[]
  lastSeq: number
  /** 已从服务端拉全基准（false=只收到过广播片段，投影可能缺头） */
  loaded: boolean
  /** 在途 assistant 流式文本（delta 只走 SSE；成轮后由 assistant 事件取代） */
  liveDelta: string
  turns: AgentTurn[]
  running: boolean
  requestId: string | null
  error: string
  errorHint: LlmErrorHint | null
  doneInfo: AgentDonePayload | null
  subProcs: Record<string, SubProc>
  /** 快照里无运行记录时的本地中断标记（投影会把在途卡收尾） */
  interrupted: boolean
  /** 事件拉取失败信息（UI 重试） */
  loadFail: string
  lastTouch: number
  wasRunning: boolean
  /** 该会话持久化队列镜像（task=收尾续发，inject=运行中注入；事实源在主进程 agent_queue 表） */
  queue: AgentQueueItem[]
}

interface AgentRunState {
  projectId: string | null
  activeId: string | null
  sessions: Record<string, SessionBuf>
  // active 会话（或草稿）的镜像平面字段——既有 UI 消费面
  requestId: string | null
  sessionId: string | null
  sessionCreatedAt: number
  turns: AgentTurn[]
  running: boolean
  error: string
  errorHint: LlmErrorHint | null
  doneInfo: AgentDonePayload | null
  subProcs: Record<string, SubProc>
  /** 当前项目正在运行（含 invoke 在途）的会话 id 集——tab/徽章/导航圆点消费 */
  runningIds: string[]
  /** active 会话事件拉取失败（区别于 run 错误，可重试） */
  loadFailed: boolean
  /** active 会话（或草稿）的队列镜像 */
  queue: AgentQueueItem[]
  /** 上条 run 被用户停止（区别于 error，队列继续入口的判定依据） */
  interrupted: boolean
}

export const useAgentRunStore = create<AgentRunState>(() => ({
  projectId: null,
  activeId: null,
  sessions: {},
  requestId: null,
  sessionId: null,
  sessionCreatedAt: Date.now(),
  turns: [],
  running: false,
  error: '',
  errorHint: null,
  doneInfo: null,
  subProcs: {},
  runningIds: [],
  loadFailed: false,
  queue: [],
  interrupted: false
}))

// —— 模块级可变结构 ——
/** run 代际：仅项目切换递增（作废悬空的 invoke 回包）；切会话/停止不作废（run 继续） */
let genToken = 0
/** rid → sessionId 索引：delta/done/error/subEvent 等只带 rid 的事件借此定位会话 */
const ridIndex = new Map<string, string>()
/** invoke 在途的乐观用户消息（key=目标会话 id；null=草稿起步、会话 id 未知） */
const pendingStarts = new Map<string | null, string>()
/** 草稿视图的兜底错误（activeId=null 时无处挂 error） */
let draftError = ''
let draftErrorHint: LlmErrorHint | null = null
/** 当前项目在快照里仍 running 但本地无缓冲的会话（驱动活跃轮询） */
const foreignRunning = new Set<string>()
/** 会话缓冲上限：超出时淘汰非活跃非运行的 LRU */
const MAX_BUFS = 10

// delta 缓冲（rAF 节流；并行 run 时先刷旧会话再缓冲新的）
let pendingDelta = ''
let pendingDeltaSid: string | null = null
let rafId: number | null = null

function lastActiveKey(projectId: string): string {
  return `nm.agent.active.${projectId}`
}

function ensureBuf(sid: string): SessionBuf {
  const s = useAgentRunStore.getState()
  const existing = s.sessions[sid]
  if (existing) return existing
  const buf: SessionBuf = {
    id: sid,
    createdAt: Date.now(),
    events: [],
    lastSeq: 0,
    loaded: false,
    liveDelta: '',
    turns: [],
    running: false,
    requestId: null,
    error: '',
    errorHint: null,
    doneInfo: null,
    subProcs: {},
    interrupted: false,
    loadFail: '',
    lastTouch: Date.now(),
    wasRunning: false,
    queue: []
  }
  useAgentRunStore.setState({ sessions: { ...s.sessions, [sid]: buf } })
  evictStaleBufs()
  return buf
}

function evictStaleBufs(): void {
  const s = useAgentRunStore.getState()
  const ids = Object.keys(s.sessions)
  if (ids.length <= MAX_BUFS) return
  const evictable = ids
    .filter(
      (id) => id !== s.activeId && !s.sessions[id].running && s.sessions[id].queue.length === 0
    )
    .sort((a, b) => s.sessions[a].lastTouch - s.sessions[b].lastTouch)
  for (const id of evictable.slice(0, ids.length - MAX_BUFS)) {
    const next = { ...useAgentRunStore.getState().sessions }
    delete next[id]
    useAgentRunStore.setState({ sessions: next })
    for (const [rid, sid] of ridIndex) if (sid === id) ridIndex.delete(rid)
  }
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

function hasConfirmingCard(turns: AgentTurn[]): boolean {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.role !== 'assistant') break
    if (t.toolCalls.some((c) => c.state === 'confirming')) return true
  }
  return false
}

/** 投影：权威事件 → turns；liveDelta 作为在途 assistant 尾轮；interrupted 时收尾在途卡 */
function projectTurns(buf: SessionBuf): AgentTurn[] {
  let turns = eventsToTurns(buf.events)
  if (buf.interrupted) turns = finalizeTurns(turns)
  if (buf.liveDelta) {
    turns = [
      ...turns,
      {
        role: 'assistant',
        text: buf.liveDelta,
        toolCalls: [],
        segments: [{ kind: 'text', text: buf.liveDelta }],
        ts: Date.now()
      }
    ]
  }
  return turns
}

function mirrorOf(sid: string, buf: SessionBuf): Partial<AgentRunState> {
  return {
    sessionId: sid,
    sessionCreatedAt: buf.createdAt,
    turns: buf.turns,
    // invoke 在途（乐观 user turn 已上屏）也视为运行中，防 UI 连点双发
    running: buf.running || !!pendingStarts.get(sid),
    requestId: buf.requestId,
    error: buf.error || buf.loadFail,
    errorHint: buf.errorHint,
    doneInfo: buf.doneInfo,
    subProcs: buf.subProcs,
    loadFailed: !!buf.loadFail,
    queue: buf.queue,
    interrupted: buf.interrupted
  }
}

/** 由 sessions + pendingStarts 派生运行中的会话 id 集 */
function runningIdsOf(sessions: Record<string, SessionBuf>): string[] {
  const ids: string[] = []
  for (const sid of Object.keys(sessions)) {
    if (sessions[sid].running || pendingStarts.has(sid)) ids.push(sid)
  }
  return ids
}

/** 所有会话写入的统一入口：mutate buf → 重投影 → active 则镜像 + agentUi 同步 */
function applyBuf(sid: string, fn: (b: SessionBuf) => void): void {
  const s = useAgentRunStore.getState()
  const buf = s.sessions[sid]
  if (!buf) return
  fn(buf)
  buf.lastTouch = Date.now()
  buf.turns = projectTurns(buf)
  const patch: Partial<AgentRunState> = {
    sessions: { ...s.sessions, [sid]: buf },
    runningIds: runningIdsOf({ ...s.sessions, [sid]: buf })
  }
  if (s.activeId === sid) Object.assign(patch, mirrorOf(sid, buf))
  useAgentRunStore.setState(patch)
  if (s.activeId === sid) {
    const effectiveRunning = buf.running || !!pendingStarts.get(sid)
    if (buf.wasRunning && !effectiveRunning) {
      setAgentUi({
        running: false,
        confirming: false,
        ended: { at: Date.now(), ok: !buf.error }
      })
    } else {
      setAgentUi({ running: effectiveRunning, confirming: hasConfirmingCard(buf.turns) })
    }
  }
  buf.wasRunning = buf.running
}

/** 草稿/镜像统一刷新（activeId 为空时把 pendingStarts/draftError 投影到平面字段） */
function refreshView(): void {
  const s = useAgentRunStore.getState()
  if (s.activeId) {
    const buf = s.sessions[s.activeId]
    if (buf) {
      useAgentRunStore.setState(mirrorOf(s.activeId, buf))
      return
    }
  }
  const draftPending = pendingStarts.get(null)
  useAgentRunStore.setState({
    sessionId: null,
    sessionCreatedAt: Date.now(),
    requestId: null,
    turns: draftPending ? [{ role: 'user', text: draftPending, ts: Date.now() }] : [],
    running: !!draftPending,
    error: draftError,
    errorHint: draftErrorHint,
    doneInfo: null,
    subProcs: {},
    runningIds: runningIdsOf(useAgentRunStore.getState().sessions),
    loadFailed: false,
    queue: []
  })
}

// —— 事件拉取（事实源对账） ——

const fetchInFlight = new Set<string>()

function fetchEvents(sid: string): void {
  if (fetchInFlight.has(sid)) return
  const buf = useAgentRunStore.getState().sessions[sid]
  if (!buf) return
  fetchInFlight.add(sid)
  const afterSeq = buf.loaded ? buf.lastSeq : 0
  const ridAtStart = buf.requestId
  window.api.agent
    .sessionEvents({ sessionId: sid, afterSeq })
    .then((res) => {
      fetchInFlight.delete(sid)
      let terminal = false
      applyBuf(sid, (b) => {
        // 广播与补拉按 seq 去重合并（竞态安全：既不丢广播也不丢补拉）
        const bySeq = new Map(b.events.map((e) => [e.seq, e]))
        for (const e of res.events) bySeq.set(e.seq, e)
        b.events = [...bySeq.values()].sort((x, y) => x.seq - y.seq)
        b.lastSeq = Math.max(b.lastSeq, res.lastSeq)
        b.loaded = true
        b.interrupted = false
        b.loadFail = ''
        // 广播丢失时的兜底：末事件为终态而本地仍标 running → 收尾。
        // requestId 已变（排队续发等新 run 已接管）则绝不误杀新 run
        const last = res.events[res.events.length - 1]
        if (
          b.running &&
          b.requestId === ridAtStart &&
          last &&
          (last.kind === 'done' || last.kind === 'run_error')
        ) {
          terminal = true
          b.running = false
          b.requestId = null
          b.liveDelta = ''
          if (last.kind === 'done') {
            b.doneInfo = { ...last.summary }
            b.error = ''
            b.errorHint = null
          } else {
            b.error = last.message
            b.errorHint = classifyLlmError(last.message)
          }
        }
      })
      if (terminal && pendingDeltaSid === sid) {
        pendingDelta = ''
        pendingDeltaSid = null
      }
    })
    .catch((err: unknown) => {
      fetchInFlight.delete(sid)
      const msg = (err as Error).message || '事件同步失败'
      // 他端已删除的会话：清缓冲与 tab，active 被清则回草稿（不留幽灵空会话）
      if (msg.includes('会话不存在')) {
        const st = useAgentRunStore.getState()
        const next = { ...st.sessions }
        delete next[sid]
        useAgentRunStore.setState({ sessions: next, runningIds: runningIdsOf(next) })
        if (st.projectId) {
          useAgentTabsStore.getState().dropSessionTabs(st.projectId, sid)
        }
        void queryClient.invalidateQueries({ queryKey: qk.agentSessionsAll })
        if (st.activeId === sid) switchSession(null)
        return
      }
      applyBuf(sid, (b) => {
        b.loadFail = msg
      })
    })
}

// —— 运行控制 ——

export function startRun(input: string, model?: string, provider?: ProviderId): void {
  const s = useAgentRunStore.getState()
  const text = input.trim()
  if (!text || !s.projectId) return
  const target = s.activeId
  const pid = s.projectId
  if (target && s.sessions[target]?.running) return
  const token = ++genToken
  pendingStarts.set(target, text)
  refreshView()
  // pendingStarts 只影响 refreshView 的 running 镜像，显式同步徽章数据
  useAgentRunStore.setState({ runningIds: runningIdsOf(useAgentRunStore.getState().sessions) })
  setAgentUi({ running: true, confirming: false, ended: null })
  void window.api.agent
    .run(
      target
        ? { projectId: pid, sessionId: target, text, model, provider }
        : { projectId: pid, text, model, provider }
    )
    .then((id) => {
      if (useAgentRunStore.getState().projectId !== pid) return
      if (token !== genToken) return
      if (typeof id === 'string') return // 旧路径（messages 直跑）不会出现在新客户端，防御
      pendingStarts.delete(target)
      pendingStarts.delete(id.sessionId)
      ridIndex.set(id.requestId, id.sessionId)
      ensureBuf(id.sessionId)
      applyBuf(id.sessionId, (b) => {
        b.running = true
        b.requestId = id.requestId
        b.error = ''
        b.errorHint = null
        b.doneInfo = null
        b.interrupted = false
      })
      // 草稿起步且用户仍停在草稿视图 → 切到新会话
      if (!target && useAgentRunStore.getState().activeId === null) {
        switchSession(id.sessionId)
      } else {
        fetchEvents(id.sessionId)
      }
    })
    .catch(async (err: unknown) => {
      if (token !== genToken) return
      if (useAgentRunStore.getState().projectId !== pid) return
      pendingStarts.delete(target)
      await reconcileFailedStart(pid, target, text, (err as Error).message)
    })
}

/**
 * invoke 失败对账：响应丢失≠任务未启动。按快照找回本会话（或唯一候选）运行并接管；
 * 找不到才判真失败——绝不因网络抖动把已发出的任务当成没发出。
 */
async function reconcileFailedStart(
  projectId: string,
  knownSid: string | null,
  text: string,
  message: string
): Promise<void> {
  const fail = (msg: string): void => {
    if (knownSid) {
      const buf = useAgentRunStore.getState().sessions[knownSid]
      if (buf && !buf.running) {
        applyBuf(knownSid, (b) => {
          b.error = msg
          b.errorHint = classifyLlmError(msg)
        })
      }
    } else {
      draftError = msg
      draftErrorHint = classifyLlmError(msg)
      setAgentUi({ running: false, confirming: false, ended: { at: Date.now(), ok: false } })
      refreshView()
    }
  }
  let snap: RuntimeSnapshot | null = null
  try {
    snap = await window.api.runtime.snapshot()
  } catch {
    /* 网络全断：快照也不可用，只能报原始错误 */
  }
  if (knownSid) {
    const rec = snap?.runs.find((r) => r.kind === 'agent' && r.meta?.sessionId === knownSid)
    if (rec && rec.status === 'running') {
      adoptFromRecord(rec)
      return
    }
    fail(message)
    return
  }
  // 草稿起步（服务端建了新会话、sid 未知）：找本项目未知会话的唯一 running 候选，按 user 文本验证
  const known = new Set(Object.keys(useAgentRunStore.getState().sessions))
  const cands = (snap?.runs ?? []).filter(
    (r) =>
      r.kind === 'agent' &&
      r.status === 'running' &&
      r.meta?.projectId === projectId &&
      r.meta?.sessionId &&
      !known.has(r.meta.sessionId)
  )
  if (cands.length === 1) {
    const sid = cands[0].meta?.sessionId as string
    try {
      const res = await window.api.agent.sessionEvents({ sessionId: sid })
      const users = res.events.filter((e) => e.kind === 'user')
      const lastUser = users[users.length - 1]
      if (lastUser && lastUser.kind === 'user' && lastUser.text === text) {
        ridIndex.set(cands[0].id, sid)
        ensureBuf(sid)
        applyBuf(sid, (b) => {
          b.running = true
          b.requestId = cands[0].id
        })
        if (useAgentRunStore.getState().activeId === null) switchSession(sid)
        else fetchEvents(sid)
        return
      }
    } catch {
      /* 验证失败走失败路径 */
    }
  }
  if (cands.length > 1) {
    fail('网络异常：任务可能已在后台启动，请稍后在会话列表中查看')
    return
  }
  fail(message)
}

/**
 * 运行中向当前 run 注入修正指令（主进程安全点：工具返回后、下一轮模型调用前生效，
 * 落为正常 user 消息进会话历史）。非运行态忽略；返回 false=未入队（UI 回填输入框）。
 */
export async function injectRun(text: string): Promise<boolean> {
  const s = useAgentRunStore.getState()
  const sid = s.activeId
  const t = text.trim()
  if (!t || !sid || !s.projectId) return false
  const buf = s.sessions[sid]
  if (!buf || !(buf.running || pendingStarts.has(sid))) return false
  try {
    await window.api.agent.queueAdd({
      sessionId: sid,
      projectId: s.projectId,
      kind: 'inject',
      text: t
    })
    return true
  } catch {
    return false
  }
}

/** 显式排队任务：run 成功收尾后由主进程按序续发（失败/停止冻结，手动继续）。非运行态忽略。 */
export async function queueTask(
  text: string,
  model?: string,
  provider?: ProviderId
): Promise<boolean> {
  const s = useAgentRunStore.getState()
  const sid = s.activeId
  const t = text.trim()
  if (!t || !sid || !s.projectId) return false
  const buf = s.sessions[sid]
  if (!buf || !(buf.running || pendingStarts.has(sid))) return false
  try {
    await window.api.agent.queueAdd({
      sessionId: sid,
      projectId: s.projectId,
      kind: 'task',
      text: t,
      model,
      provider
    })
    return true
  } catch {
    return false
  }
}

/** 取消队列项：返回被取消的文本（UI 回填输入框） */
export async function cancelQueued(id: string): Promise<string | null> {
  const s = useAgentRunStore.getState()
  const item = s.queue.find((q) => q.id === id)
  if (!item) return null
  try {
    await window.api.agent.queueRemove(id)
  } catch {
    return null
  }
  return item.text
}

/** 调整排队任务顺序（仅 task；inject 无顺序语义） */
export function moveQueued(id: string, dir: 'up' | 'down'): void {
  void window.api.agent.queueMove(id, dir).catch(() => {})
}

/** 手动继续冻结的队列（失败/停止后）：主进程消费下一条启动 run */
export function resumeQueue(): void {
  const s = useAgentRunStore.getState()
  if (!s.sessionId) return
  void window.api.agent
    .queueResume(s.sessionId)
    .then((res) => {
      // null=会话活跃中/无可消费项，维持原状；否则乐观接管新 run（不等 10s 快照 tick）
      if (!res) return
      ridIndex.set(res.requestId, res.sessionId)
      ensureBuf(res.sessionId)
      applyBuf(res.sessionId, (b) => {
        b.running = true
        b.requestId = res.requestId
        b.interrupted = false
        b.error = ''
        b.errorHint = null
      })
      fetchEvents(res.sessionId)
    })
    .catch(() => {})
}

/** 队列镜像分发：按会话分组写入 buf.queue（引用变化才写，防无谓重渲） */
function applyQueueMirror(projectId: string, items: AgentQueueItem[]): void {
  const s = useAgentRunStore.getState()
  if (s.projectId !== projectId) return
  const bySid = new Map<string, AgentQueueItem[]>()
  for (const it of items) {
    const arr = bySid.get(it.sessionId) ?? []
    arr.push(it)
    bySid.set(it.sessionId, arr)
  }
  let changed = false
  for (const sid of Object.keys(s.sessions)) {
    const next = bySid.get(sid) ?? []
    const cur = s.sessions[sid].queue
    if (cur.length !== next.length || cur.some((q, i) => q.id !== next[i].id)) {
      applyBuf(sid, (b) => {
        b.queue = next
      })
      changed = true
    }
  }
  if (changed || !s.activeId) refreshView()
}

export function stopRun(): void {
  const s = useAgentRunStore.getState()
  if (s.requestId) {
    void window.api.agent.abort(s.requestId).catch(() => {})
    return
  }
  const sid = s.activeId
  if (!sid) {
    // 草稿起步 invoke 在途：放弃本地等待（服务端若已实际启动，快照对账会重新接管为外来运行）
    pendingStarts.delete(null)
    setAgentUi({ running: false, confirming: false, ended: { at: Date.now(), ok: false } })
    refreshView()
    return
  }
  // requestId 未知（invoke 悬挂/刚接管未完成）：先对账再杀
  void window.api.runtime
    .snapshot()
    .then((snap) => {
      const rec = snap.runs.find((r) => r.kind === 'agent' && r.meta?.sessionId === sid)
      if (rec) {
        adoptFromRecord(rec)
        void window.api.agent.abort(rec.id).catch(() => {})
      } else {
        applyBuf(sid, (b) => {
          if (!b.running) return
          b.running = false
          b.requestId = null
          b.interrupted = true
          b.error = '已停止'
        })
      }
    })
    .catch(() => {})
}

export function resolveConfirm(allow: boolean, always: boolean): void {
  const s = useAgentRunStore.getState()
  const target = s.turns.length > 0 ? findConfirmTarget(s.turns) : null
  if (!target) return
  if (s.requestId) {
    void window.api.agent.resolve(s.requestId, target.id, allow, always)
    return
  }
  const sid = s.activeId
  if (!sid) return
  void window.api.runtime
    .snapshot()
    .then((snap) => {
      const rec = snap.runs.find((r) => r.kind === 'agent' && r.meta?.sessionId === sid)
      if (rec) {
        adoptFromRecord(rec)
        void window.api.agent.resolve(rec.id, target.id, allow, always)
      }
    })
    .catch(() => {})
}

function findConfirmTarget(turns: AgentTurn[]): AgentToolCall | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.role !== 'assistant') break
    const c = t.toolCalls.find((x) => x.state === 'confirming')
    if (c) return c
  }
  return null
}

/** 订阅确认目标（引用稳定：直接取 turns 内的 call 对象） */
export function useAgentConfirmTarget(): AgentToolCall | null {
  return useAgentRunStore((s) => (s.turns.length > 0 ? findConfirmTarget(s.turns) : null))
}

// —— 会话切换（永不 abort；杀 run 只能靠会话内停止按钮） ——

export function switchSession(id: string | null): void {
  const s = useAgentRunStore.getState()
  if (s.activeId === id) {
    refreshView()
    return
  }
  if (id) {
    const buf = ensureBuf(id)
    useAgentRunStore.setState({ activeId: id })
    useAgentRunStore.setState(mirrorOf(id, buf))
    if (!buf.loaded) fetchEvents(id)
    // 队列镜像兜底刷新（广播只在变化时来，刚打开的会话可能缺历史队列）
    const pid = useAgentRunStore.getState().projectId
    if (pid) void window.api.agent.queueList(pid).then((items) => applyQueueMirror(pid, items))
  } else {
    useAgentRunStore.setState({ activeId: null })
    refreshView()
  }
  const pid = useAgentRunStore.getState().projectId
  if (pid) {
    if (id) localStorage.setItem(lastActiveKey(pid), id)
    else localStorage.removeItem(lastActiveKey(pid))
  }
}

/**
 * 项目对账：同项目幂等 no-op；项目变化不 abort（跨会话并行/后台续跑），
 * 清空缓冲后按 localStorage 恢复上次活跃会话（无记录则草稿）。
 */
export function syncProject(projectId: string): void {
  const s = useAgentRunStore.getState()
  if (s.projectId === projectId) return
  genToken++
  pendingStarts.clear()
  ridIndex.clear()
  foreignRunning.clear()
  draftError = ''
  draftErrorHint = null
  useAgentRunStore.setState({
    projectId: projectId || null,
    activeId: null,
    sessions: {},
    requestId: null,
    sessionId: null,
    sessionCreatedAt: Date.now(),
    turns: [],
    running: false,
    error: '',
    errorHint: null,
    doneInfo: null,
    subProcs: {},
    runningIds: [],
    loadFailed: false,
    queue: []
  })
  setAgentUi({ running: false, confirming: false })
  if (!projectId) return
  const saved = localStorage.getItem(lastActiveKey(projectId))
  if (saved) switchSession(saved)
}

/** 手动改名：服务端 updateTitle + 失效列表 */
export function renameSessionTitle(sid: string, projectId: string, title: string): Promise<void> {
  return window.api.agent.sessionRename(sid, title).then(() => {
    void queryClient.invalidateQueries({ queryKey: qk.agentSessions(projectId) })
  })
}

// —— 收尾路径（SSE done/error 与快照对账共用；rid → 会话） ——

export function applyAgentDone(id: string, payload: AgentDonePayload): boolean {
  const sid = ridIndex.get(id)
  if (!sid) return false
  const isBg = useAgentRunStore.getState().activeId !== sid
  if (pendingDeltaSid === sid) {
    pendingDelta = ''
    pendingDeltaSid = null
  }
  applyBuf(sid, (b) => {
    b.running = false
    b.requestId = null
    b.doneInfo = payload
    b.error = ''
    b.errorHint = null
    b.interrupted = false
    b.liveDelta = ''
  })
  fetchEvents(sid)
  // agent 工具可能已改写章节/设定：失效整个 novel 域（手机端无桌面 App 的全量失效兜底）
  void queryClient.invalidateQueries({ queryKey: qk.novel })
  if (isBg) pushToast('success', '后台智能体任务已完成')
  return true
}

export function applyAgentError(id: string, message: string, hint?: LlmErrorHint): boolean {
  const sid = ridIndex.get(id)
  if (!sid) return false
  const isBg = useAgentRunStore.getState().activeId !== sid
  if (pendingDeltaSid === sid) {
    pendingDelta = ''
    pendingDeltaSid = null
  }
  applyBuf(sid, (b) => {
    b.running = false
    b.requestId = null
    b.error = message
    b.errorHint = hint ?? classifyLlmError(message)
    b.interrupted = false
    b.liveDelta = ''
  })
  fetchEvents(sid)
  // 出错前工具可能已落库部分改动：与 done 同样失效 novel 域
  void queryClient.invalidateQueries({ queryKey: qk.novel })
  if (isBg) {
    const { errorHint } = useAgentRunStore.getState()
    pushToast(
      'error',
      errorHint?.friendly
        ? `后台智能体任务失败：${errorHint.friendly}`
        : `后台智能体任务失败：${message}`
    )
  }
  return true
}

/** 中央同步器活跃判定：invoke 在途 / 任一缓冲运行中 / 本项目外来运行 → 10s 活跃轮询 */
export function agentRunActive(): boolean {
  if (pendingStarts.size > 0) return true
  const s = useAgentRunStore.getState()
  if (Object.values(s.sessions).some((b) => b.running)) return true
  return foreignRunning.size > 0
}

/** 任意会话（含草稿起步）在运行——导航圆点/全局徽章用 */
export function useAnyAgentRunning(): boolean {
  return useAgentRunStore((s) => s.running || s.runningIds.length > 0)
}

/** 事件拉取失败后的手动重试：清 loadFail 并立即补拉 active 会话 */
export function retryLoadActive(): void {
  const s = useAgentRunStore.getState()
  if (!s.activeId) return
  const sid = s.activeId
  applyBuf(sid, (b) => {
    b.loadFail = ''
  })
  fetchEvents(sid)
}

type SnapRun = RuntimeSnapshot['runs'][number]

/** 快照运行记录 → 本地缓冲接管（建 rid 索引、补拉事件；确认卡缺失时兜底重拉） */
function adoptFromRecord(rec: SnapRun): void {
  const sid = rec.meta?.sessionId
  if (!sid) return
  ridIndex.set(rec.id, sid)
  const buf = ensureBuf(sid)
  applyBuf(sid, (b) => {
    b.running = true
    b.requestId = rec.id
    b.interrupted = false
    b.error = ''
    b.errorHint = null
  })
  if (!buf.loaded) {
    fetchEvents(sid)
    return
  }
  if (rec.pendingConfirm && !hasConfirmingCard(buf.turns)) fetchEvents(sid)
}

function settleInterrupted(sid: string): void {
  applyBuf(sid, (b) => {
    if (!b.running) return
    b.running = false
    b.requestId = null
    b.interrupted = true
    b.error = '连接中断，任务状态未知（服务可能已重启）'
    b.errorHint = null
  })
  fetchEvents(sid)
}

/**
 * runtime:snapshot 对账（中央同步器每 tick 调用）——纯状态驱动、天然幂等：
 * ① 已知缓冲：running 记录校准 rid/确认卡；done/error 记录收尾；无记录且仍标 running → 判中断。
 * ② 未知会话的 running 记录：登记 foreignRunning（驱动轮询与列表失效），绝不抢占当前视图。
 */
export function syncAgentFromSnapshot(snap: RuntimeSnapshot): void {
  const s = useAgentRunStore.getState()
  foreignRunning.clear()
  for (const rec of snap.runs) {
    if (rec.kind !== 'agent' || !rec.meta?.sessionId) continue
    if (s.projectId && rec.meta.projectId && rec.meta.projectId !== s.projectId) continue
    const sid = rec.meta.sessionId
    const buf = s.sessions[sid]
    if (!buf) {
      if (rec.status === 'running') foreignRunning.add(sid)
      continue
    }
    if (rec.status === 'running') {
      if (!buf.running || buf.requestId !== rec.id) adoptFromRecord(rec)
      else if (rec.pendingConfirm && !hasConfirmingCard(buf.turns)) fetchEvents(sid)
    } else if (buf.running || buf.requestId === rec.id) {
      if (rec.status === 'done') {
        const payload = rec.donePayload as AgentDonePayload | undefined
        if (payload) applyAgentDone(rec.id, payload)
        else applyAgentError(rec.id, '任务已完成，但结果未同步')
      } else {
        applyAgentError(rec.id, rec.error ?? '生成失败')
      }
    }
  }
  // 仍标 running 但快照无对应记录：主进程重启/记录丢失 → 以事件为准收尾
  for (const sid of Object.keys(s.sessions)) {
    const buf = s.sessions[sid]
    if (!buf.running || !buf.requestId) continue
    const rec = snap.runs.find((r) => r.kind === 'agent' && r.id === buf.requestId)
    if (!rec) settleInterrupted(sid)
  }
}

// —— 事件桥 ——

/** SSE 重连成功/页面回前台后的全量对账：所有已打开会话无条件补拉（幂等，fetchInFlight 防重入） */
function reconcileAllSessions(): void {
  for (const sid of Object.keys(useAgentRunStore.getState().sessions)) {
    fetchEvents(sid)
  }
}

/** 挂全局事件桥（幂等，两端 App 连接就绪后调用一次；与组件存活无关） */
export function ensureAgentRuntime(): void {
  ensureBridge('agentRun', () => {
    registerAgentSubEvents()

    // web-bridge SSE 断线重连成功：断流期间尾部事件丢失无 gap 触发，必须无条件对账
    window.addEventListener('nm-sse-open', reconcileAllSessions)

    window.api.agent.onTranscript((_rid, sid, ev) => {
      const s = useAgentRunStore.getState()
      const buf = s.sessions[sid]
      if (!buf) {
        // 未打开的会话（他端/后台启动）：只刷列表（徽章/时间），不开缓冲
        void queryClient.invalidateQueries({ queryKey: qk.agentSessionsAll })
        return
      }
      if (buf.loaded && ev.seq <= buf.lastSeq) return
      const gap = buf.loaded && ev.seq > buf.lastSeq + 1
      applyBuf(sid, (b) => {
        b.events = [...b.events.filter((e) => e.seq !== ev.seq), ev].sort((x, y) => x.seq - y.seq)
        b.lastSeq = Math.max(b.lastSeq, ev.seq)
        switch (ev.kind) {
          case 'assistant':
            b.liveDelta = ''
            break
          case 'done':
            b.running = false
            b.requestId = null
            b.doneInfo = { ...ev.summary }
            b.error = ''
            b.errorHint = null
            b.interrupted = false
            b.liveDelta = ''
            break
          case 'run_error':
            b.running = false
            b.requestId = null
            b.error = ev.message
            b.errorHint = classifyLlmError(ev.message)
            b.interrupted = false
            b.liveDelta = ''
            break
          default:
            break
        }
      })
      // 权威事件已含全文/终态：丢弃同会话未 flush 的流式残片，防投影尾部重复
      if (
        (ev.kind === 'assistant' || ev.kind === 'done' || ev.kind === 'run_error') &&
        pendingDeltaSid === sid
      ) {
        pendingDelta = ''
        pendingDeltaSid = null
      }
      if (ev.kind === 'user') {
        if (pendingStarts.get(sid) === ev.text) pendingStarts.delete(sid)
        if (pendingStarts.get(null) === ev.text) pendingStarts.delete(null)
        refreshView()
        void queryClient.invalidateQueries({ queryKey: qk.agentSessionsAll })
      }
      if (gap) fetchEvents(sid)
      if (ev.kind === 'done' || ev.kind === 'run_error') {
        void queryClient.invalidateQueries({ queryKey: qk.agentSessionsAll })
        // 权威收尾事件：agent 工具可能已改写章节/设定，失效 novel 域让列表/正文立即刷新
        void queryClient.invalidateQueries({ queryKey: qk.novel })
        if (s.activeId !== sid) {
          pushToast(
            ev.kind === 'done' ? 'success' : 'error',
            ev.kind === 'done' ? '后台智能体任务已完成' : `后台智能体任务失败：${ev.message}`
          )
          fetchEvents(sid)
        }
      }
    })

    window.api.agent.onQueue((projectId, items) => {
      applyQueueMirror(projectId, items)
    })

    window.api.agent.onDelta((id, text) => {
      const sid = ridIndex.get(id)
      if (!sid) return
      if (pendingDeltaSid !== null && pendingDeltaSid !== sid) flushDelta()
      pendingDeltaSid = sid
      pendingDelta += text
      scheduleFlush()
    })

    window.api.agent.onDone((id, payload) => {
      applyAgentDone(id, payload)
    })

    window.api.agent.onError((id, message, hint) => {
      applyAgentError(id, message, hint)
    })

    // 页面从后台回前台：rAF 在后台被冻结，缓冲的 delta 立即刷入；
    // 同时后台期间的事件可能整段丢失，无条件对账所有已打开会话
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (pendingDelta) flushDelta()
        reconcileAllSessions()
      }
    })
  })
}

function flushDelta(): void {
  rafId = null
  if (!pendingDelta) return
  const chunk = pendingDelta
  const sid = pendingDeltaSid
  pendingDelta = ''
  if (!sid) return
  applyBuf(sid, (b) => {
    b.liveDelta += chunk
  })
}

function scheduleFlush(): void {
  if (rafId === null) rafId = requestAnimationFrame(flushDelta)
}

/** onSubEvent 注册体：子智能体过程归并进所属会话缓冲 */
function registerAgentSubEvents(): void {
  window.api.agent.onSubEvent((id, ev) => {
    const sid = ridIndex.get(id)
    if (!sid) return
    applyBuf(sid, (b) => {
      const cur: SubProc = b.subProcs[ev.parentId] ?? {
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
      b.subProcs = { ...b.subProcs, [ev.parentId]: next }
    })
  })
}
