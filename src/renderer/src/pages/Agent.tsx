import type { AgentToolCallEvent, AgentToolResultEvent } from '@shared/contract'
import type {
  AgentDonePayload,
  AgentInstructionsView,
  AgentSession,
  AgentSessionBrief,
  AgentToolCall,
  AgentTurn,
  ModelProbeResult,
  SettingsView
} from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Markdown } from '../components/Markdown'
import { OverlayCard } from '../components/OverlayCard'
import { Badge, Button, Card, Select, Textarea } from '../components/ui'
import { makeSessionTitle, toolLabel, toolSummary, turnsToMessages } from '../lib/agentTurns'
import { setAgentUi } from '../lib/agentUiStore'
import { fmtDuration, fmtRelative, fmtTokens } from '../lib/format'
import { qk, queries } from '../lib/queries'

type AssistantTurn = Extract<AgentTurn, { role: 'assistant' }>

interface SubProc {
  task: string
  role: string
  text: string
  tools: AgentToolCall[]
  running: boolean
}

const STATE_DOT: Record<AgentToolCall['state'], string> = {
  running: 'bg-amber-500 animate-pulse',
  confirming: 'bg-red-500 animate-pulse',
  ok: 'bg-emerald-500',
  error: 'bg-red-600',
  denied: 'bg-zinc-500'
}

const STATE_LABEL: Record<AgentToolCall['state'], string> = {
  running: '执行中',
  confirming: '等待确认',
  ok: '完成',
  error: '失败',
  denied: '已拒绝'
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

function ToolCallCard({
  call,
  canResolve,
  onResolve,
  sub
}: {
  call: AgentToolCall
  canResolve: boolean
  onResolve: (allow: boolean, always: boolean) => void
  sub?: SubProc
}) {
  const [open, setOpen] = useState(call.name === 'spawn_subagent')
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[call.state]}`} />
        <span className="shrink-0 font-mono text-[11px] text-amber-500/90">
          {toolLabel(call.name)}
        </span>
        <span className="flex-1 truncate text-xs text-zinc-300">{toolSummary(call)}</span>
        <span className="hidden shrink-0 text-[10px] text-zinc-500 sm:inline">
          {STATE_LABEL[call.state]}
        </span>
      </button>
      {sub && (
        <div className="space-y-2 border-t border-zinc-800 px-3 py-2.5">
          <div className="text-[10px] text-zinc-500">
            子智能体（{sub.role || '调研'}）{sub.running ? '· 工作中' : '· 已完成'}
          </div>
          {sub.tools.length > 0 && (
            <div className="space-y-1">
              {sub.tools.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-[11px]">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[c.state]}`} />
                  <span className="shrink-0 font-mono text-zinc-500">{toolLabel(c.name)}</span>
                  <span className="truncate text-zinc-400">{toolSummary(c)}</span>
                </div>
              ))}
            </div>
          )}
          {sub.text && (
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 text-[11px] leading-4 text-zinc-500">
              {sub.text}
            </pre>
          )}
        </div>
      )}
      {call.state === 'confirming' && canResolve && (
        <div className="border-t border-zinc-800 px-3 py-2.5">
          <div className="text-xs leading-5 text-red-300">
            ⚠ {call.dangerReason ?? '该操作不可恢复'}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={() => onResolve(true, false)}>允许</Button>
            <Button variant="ghost" onClick={() => onResolve(true, true)}>
              本次任务内不再询问
            </Button>
            <Button variant="danger" onClick={() => onResolve(false, false)}>
              拒绝
            </Button>
          </div>
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-zinc-800 px-3 py-2.5">
          <div>
            <div className="mb-1 text-[10px] text-zinc-500">参数</div>
            <pre className="max-h-48 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-400">
              {JSON.stringify(call.input, null, 2)}
            </pre>
          </div>
          {call.result !== undefined && (
            <div>
              <div className="mb-1 text-[10px] text-zinc-500">结果</div>
              <pre className="max-h-48 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-400">
                {call.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type RenderItem =
  | { kind: 'text'; text: string; key: string }
  | { kind: 'tools'; calls: AgentToolCall[]; key: string }

/** 把 turn 的 segments（时序）折叠成渲染项：相邻工具聚为一组；旧会话无 segments 回退 文本→工具 顺序。
 * key 用确定性序号生成（跨渲染稳定），不能用文本长度/内容派生——流式时会导致 remount */
function buildRenderItems(turn: AssistantTurn): RenderItem[] {
  const byId = new Map(turn.toolCalls.map((c) => [c.id, c]))
  let textSeq = 0
  let toolSeq = 0
  if (turn.segments && turn.segments.length > 0) {
    const items: RenderItem[] = []
    for (const seg of turn.segments) {
      if (seg.kind === 'text') {
        if (!seg.text) continue
        const last = items[items.length - 1]
        if (last?.kind === 'text') last.text += seg.text
        else items.push({ kind: 'text', text: seg.text, key: `t${textSeq++}` })
      } else {
        const call = byId.get(seg.callId)
        if (!call) continue
        const last = items[items.length - 1]
        if (last?.kind === 'tools') last.calls.push(call)
        else items.push({ kind: 'tools', calls: [call], key: `g${toolSeq++}` })
      }
    }
    if (items.length > 0) return items
  }
  const items: RenderItem[] = []
  if (turn.text) items.push({ kind: 'text', text: turn.text, key: `t${textSeq++}` })
  if (turn.toolCalls.length > 0)
    items.push({ kind: 'tools', calls: [...turn.toolCalls], key: `g${toolSeq++}` })
  return items
}

function ToolGroup({
  calls,
  running,
  confirmTargetId,
  onResolve,
  subProcs
}: {
  calls: AgentToolCall[]
  running: boolean
  confirmTargetId: string | null
  onResolve: (allow: boolean, always: boolean) => void
  subProcs: Record<string, SubProc>
}) {
  const hasActive = calls.some((c) => c.state === 'running' || c.state === 'confirming')
  const [open, setOpen] = useState(hasActive)
  useEffect(() => {
    if (hasActive) setOpen(true)
  }, [hasActive])
  const dot = calls.some((c) => c.state === 'confirming')
    ? 'bg-red-500 animate-pulse'
    : hasActive
      ? 'bg-amber-500 animate-pulse'
      : calls.some((c) => c.state === 'error' || c.state === 'denied')
        ? 'bg-red-600'
        : 'bg-emerald-500'
  const active = calls.filter((c) => c.state === 'running' || c.state === 'confirming').length
  const last = calls[calls.length - 1]
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-1.5 text-left"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className="shrink-0 font-mono text-[11px] text-amber-500/70">
          工具 × {calls.length}
        </span>
        <span className="flex-1 truncate text-xs text-zinc-400">
          {active > 0 && <span className="text-amber-400/80">执行中 {active} 项 · </span>}
          {toolLabel(last.name)} {toolSummary(last)}
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`h-3 w-3 shrink-0 text-zinc-600 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-zinc-800 p-1.5">
          {calls.map((call) => (
            <ToolCallCard
              key={call.id}
              call={call}
              canResolve={running && call.id === confirmTargetId}
              onResolve={onResolve}
              sub={subProcs[call.id]}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function Agent({ projectId }: { projectId: string }) {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [probe, setProbe] = useState<ModelProbeResult | null>(null)
  const [model, setModel] = useState('')
  const queryClient = useQueryClient()
  const { data: sessions = [] } = useQuery(queries.agentSessions(projectId))
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [turns, setTurns] = useState<AgentTurn[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [doneInfo, setDoneInfo] = useState<AgentDonePayload | null>(null)
  const [subProcs, setSubProcs] = useState<Record<string, SubProc>>({})
  const [panelOpen, setPanelOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [instrOpen, setInstrOpen] = useState(false)
  const [instrTab, setInstrTab] = useState<'global' | 'project'>('global')
  const [instr, setInstr] = useState<AgentInstructionsView | null>(null)
  const [instrDraft, setInstrDraft] = useState({ global: '', project: '' })
  const [instrSaving, setInstrSaving] = useState(false)
  const [instrSaved, setInstrSaved] = useState(false)
  const [instrErr, setInstrErr] = useState('')
  const [showJump, setShowJump] = useState(false)
  const requestIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const sessionCreatedAtRef = useRef<number>(Date.now())
  const turnsRef = useRef<AgentTurn[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const pendingDeltaRef = useRef('')
  const rafRef = useRef<number | null>(null)

  const applyTurns = useCallback((next: AgentTurn[]): void => {
    turnsRef.current = next
    setTurns(next)
  }, [])

  const setSession = useCallback((id: string | null): void => {
    sessionIdRef.current = id
    setSessionId(id)
  }, [])

  const patchLastAssistant = useCallback(
    (fn: (t: AssistantTurn) => AgentTurn): void => {
      const prev = turnsRef.current
      if (prev.length === 0) return
      const last = prev[prev.length - 1]
      if (last.role !== 'assistant') return
      applyTurns([...prev.slice(0, -1), fn(last)])
    },
    [applyTurns]
  )

  /** 追加流式文本：同步写入 text 与 segments（旧会话无 segments 时从现有 text 迁移） */
  const appendDelta = useCallback(
    (chunk: string): void => {
      patchLastAssistant((t) => {
        const segments = t.segments ? [...t.segments] : [{ kind: 'text' as const, text: t.text }]
        const lastSeg = segments[segments.length - 1]
        if (lastSeg && lastSeg.kind === 'text')
          segments[segments.length - 1] = { kind: 'text', text: lastSeg.text + chunk }
        else segments.push({ kind: 'text', text: chunk })
        return { ...t, text: t.text + chunk, segments }
      })
    },
    [patchLastAssistant]
  )

  const flushDelta = useCallback((): void => {
    rafRef.current = null
    const chunk = pendingDeltaRef.current
    if (!chunk) return
    pendingDeltaRef.current = ''
    appendDelta(chunk)
  }, [appendDelta])

  const refreshSessions = useCallback(
    (pid: string): void => {
      void queryClient.invalidateQueries({ queryKey: qk.agentSessions(pid) })
    },
    [queryClient]
  )

  const persist = useCallback(
    (sid: string, finalTurns: AgentTurn[]): void => {
      const session: AgentSession = {
        id: sid,
        projectId,
        title: makeSessionTitle(finalTurns),
        createdAt: sessionCreatedAtRef.current,
        updatedAt: Date.now(),
        turns: finalTurns
      }
      void window.api.agent.sessionSave(session).then(() => refreshSessions(projectId))
    },
    [projectId, refreshSessions]
  )

  useEffect(() => {
    if (requestIdRef.current) {
      void window.api.agent.abort(requestIdRef.current)
      requestIdRef.current = null
      setRunning(false)
      setAgentUi({ running: false, confirming: false })
    }
    if (!projectId) return
    void (async () => {
      const s = await window.api.settings.get()
      setSettings(s)
      setModel(
        (() => {
          const r = s.modelRouting.agent
          if (typeof r === 'string') return r || s.defaultModel
          if (!r) return s.defaultModel
          return r.provider && r.provider !== s.provider
            ? s.defaultModel
            : r.model || s.defaultModel
        })()
      )
      try {
        setProbe(await window.api.models.probe({}))
      } catch {
        setProbe(null)
      }
    })()
    void queryClient.invalidateQueries({ queryKey: qk.agentSessions(projectId) }).then(() => {
      const list = queryClient.getQueryData(qk.agentSessions(projectId)) as AgentSessionBrief[]
      if (list.length > 0) {
        void window.api.agent.sessionLoad(list[0].id).then((session) => {
          if (!session) return
          setSession(session.id)
          applyTurns(session.turns)
          sessionCreatedAtRef.current = session.createdAt
        })
      } else {
        setSession(null)
        applyTurns([])
      }
    })
    return () => {
      const sid = sessionIdRef.current
      if (sid && turnsRef.current.length > 0) persist(sid, finalizeTurns(turnsRef.current))
    }
  }, [projectId, applyTurns, setSession, persist, queryClient])

  useEffect(() => {
    const offDelta = window.api.agent.onDelta((id, text) => {
      if (id !== requestIdRef.current) return
      pendingDeltaRef.current += text
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushDelta)
    })
    const offToolCall = window.api.agent.onToolCall((id, call: AgentToolCallEvent) => {
      if (id !== requestIdRef.current) return
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
    const offToolResult = window.api.agent.onToolResult((id, r: AgentToolResultEvent) => {
      if (id !== requestIdRef.current) return
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
      const sid = sessionIdRef.current
      if (sid) persist(sid, turnsRef.current)
    })
    const offDone = window.api.agent.onDone((id, payload) => {
      if (id !== requestIdRef.current) return
      const fixed = finalizeTurns(turnsRef.current)
      if (fixed.length > 0 && fixed[fixed.length - 1].role === 'assistant') {
        const last = fixed[fixed.length - 1] as AssistantTurn
        fixed[fixed.length - 1] = { ...last, text: payload.text || last.text }
      }
      applyTurns(fixed)
      const sid = sessionIdRef.current
      if (sid) persist(sid, fixed)
      setDoneInfo(payload)
      setRunning(false)
      requestIdRef.current = null
      setAgentUi({ running: false, confirming: false, ended: { at: Date.now(), ok: true } })
    })
    const offError = window.api.agent.onError((id, message) => {
      if (id !== requestIdRef.current) return
      const fixed = finalizeTurns(turnsRef.current)
      applyTurns(fixed)
      const sid = sessionIdRef.current
      if (sid) persist(sid, fixed)
      setError(message)
      setRunning(false)
      requestIdRef.current = null
      setAgentUi({ running: false, confirming: false, ended: { at: Date.now(), ok: false } })
    })
    const offSub = window.api.agent.onSubEvent((id, ev) => {
      if (id !== requestIdRef.current) return
      setSubProcs((prev) => {
        const cur: SubProc = prev[ev.parentId] ?? {
          task: '',
          role: '',
          text: '',
          tools: [],
          running: true
        }
        switch (ev.type) {
          case 'start':
            return { ...prev, [ev.parentId]: { ...cur, task: ev.task, role: ev.role } }
          case 'delta':
            return { ...prev, [ev.parentId]: { ...cur, text: cur.text + ev.text } }
          case 'toolCall':
            return { ...prev, [ev.parentId]: { ...cur, tools: [...cur.tools, ev.call] } }
          case 'toolResult':
            return {
              ...prev,
              [ev.parentId]: {
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
            }
          case 'done':
            return { ...prev, [ev.parentId]: { ...cur, running: false, text: ev.text } }
          case 'error':
            return { ...prev, [ev.parentId]: { ...cur, running: false } }
        }
      })
    })
    return () => {
      offDelta()
      offToolCall()
      offToolResult()
      offDone()
      offError()
      offSub()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [applyTurns, patchLastAssistant, persist, flushDelta])

  // biome-ignore lint/correctness/useExhaustiveDependencies: dep 仅作重触发信号，加入会破坏语义
  useEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [turns])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = atBottom
    setShowJump(!atBottom)
  }

  const jumpToBottom = (): void => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = true
    setShowJump(false)
    el.scrollTop = el.scrollHeight
  }

  const modelOptions = (() => {
    const ids = new Set<string>()
    if (probe)
      probe.models.forEach((m) => {
        ids.add(m)
      })
    settings?.customModels
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((m) => {
        ids.add(m)
      })
    if (model) ids.add(model)
    return [...ids]
  })()

  const confirmTarget = (() => {
    if (!running || turns.length === 0) return null
    const last = turns[turns.length - 1]
    if (last.role !== 'assistant') return null
    return last.toolCalls.find((c) => c.state === 'confirming') ?? null
  })()

  const send = (): void => {
    if (!input.trim() || running || !projectId || !model) return
    const sid = sessionId ?? crypto.randomUUID()
    if (!sessionId) {
      setSession(sid)
      sessionCreatedAtRef.current = Date.now()
    }
    const ts = Date.now()
    const next: AgentTurn[] = [
      ...turns,
      { role: 'user', text: input.trim(), ts },
      { role: 'assistant', text: '', toolCalls: [], segments: [], ts }
    ]
    applyTurns(next)
    setInput('')
    setError('')
    setDoneInfo(null)
    setSubProcs({})
    setRunning(true)
    setAgentUi({ running: true, confirming: false, ended: null })
    atBottomRef.current = true
    setShowJump(false)
    cancelPendingDelta()
    persist(sid, next)
    void window.api.agent
      .run({ projectId, messages: turnsToMessages(next), model })
      .then((id) => {
        requestIdRef.current = id
      })
      .catch((err: unknown) => {
        setError((err as Error).message)
        setRunning(false)
      })
  }

  const stop = (): void => {
    if (requestIdRef.current) void window.api.agent.abort(requestIdRef.current)
  }

  const resolveConfirm = (allow: boolean, always: boolean): void => {
    if (!requestIdRef.current || !confirmTarget) return
    void window.api.agent.resolve(requestIdRef.current, confirmTarget.id, allow, always)
  }

  const openInstructions = (): void => {
    setInstrOpen(true)
    setInstrSaved(false)
    void window.api.agent.instructionsGet(projectId).then((v) => {
      setInstr(v)
      setInstrDraft({ global: v.globalText, project: v.projectText })
    })
  }

  const saveInstructions = (): void => {
    if (!instr || instrSaving) return
    setInstrSaving(true)
    setInstrSaved(false)
    setInstrErr('')
    const tab = instrTab
    const text = instrDraft[tab]
    void window.api.agent
      .instructionsSave(tab, text, projectId)
      .then(() => {
        setInstrSaving(false)
        setInstrSaved(true)
        setInstr((v) => (v ? { ...v, [tab === 'global' ? 'globalText' : 'projectText']: text } : v))
        void queryClient.invalidateQueries({ queryKey: qk.projects })
      })
      .catch((e: unknown) => {
        setInstrSaving(false)
        setInstrErr((e as Error)?.message ?? '保存失败')
      })
  }

  const cancelPendingDelta = (): void => {
    pendingDeltaRef.current = ''
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }

  const switchSession = (id: string): void => {
    if (running) stop()
    requestIdRef.current = null
    setRunning(false)
    setAgentUi({ running: false, confirming: false })
    setPanelOpen(false)
    setRenamingId(null)
    setConfirmDeleteId(null)
    atBottomRef.current = true
    setShowJump(false)
    cancelPendingDelta()
    if (!id) {
      setSession(null)
      applyTurns([])
      setError('')
      setDoneInfo(null)
      setSubProcs({})
      return
    }
    void window.api.agent.sessionLoad(id).then((session) => {
      if (!session) return
      setSession(session.id)
      applyTurns(session.turns)
      sessionCreatedAtRef.current = session.createdAt
      setError('')
      setDoneInfo(null)
      setSubProcs({})
    })
  }

  const renameSession = (id: string, title: string): void => {
    void window.api.agent.sessionLoad(id).then((session) => {
      if (!session) return
      const next = title.trim() || makeSessionTitle(session.turns)
      void window.api.agent
        .sessionSave({ ...session, title: next })
        .then(() => refreshSessions(projectId))
    })
  }

  const deleteSessionById = (id: string): void => {
    void window.api.agent.sessionDelete(id).then(() => {
      if (id === sessionIdRef.current) {
        setSession(null)
        applyTurns([])
        setError('')
        setDoneInfo(null)
      }
      setConfirmDeleteId(null)
      refreshSessions(projectId)
    })
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-600">
        请先在左上角选择或新建项目
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-[calc(50%-0.375rem)] sm:w-56">
          <div className="mb-1.5 text-xs font-medium text-zinc-400">会话</div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:border-zinc-700"
            >
              <span className="min-w-0 flex-1 truncate">
                {sessions.find((s) => s.id === sessionId)?.title ?? '新会话'}
              </span>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={`h-3 w-3 shrink-0 text-zinc-500 transition-transform ${panelOpen ? 'rotate-180' : ''}`}
              >
                <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {panelOpen && (
              <>
                <div
                  className="fixed inset-0 z-20"
                  aria-hidden="true"
                  onClick={() => {
                    setPanelOpen(false)
                    setRenamingId(null)
                    setConfirmDeleteId(null)
                  }}
                />
                <div className="absolute left-0 top-full z-30 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 shadow-xl">
                  <button
                    type="button"
                    onClick={() => switchSession('')}
                    disabled={running}
                    className="flex w-full cursor-pointer items-center px-2.5 py-2 text-left text-xs text-amber-400 transition-colors hover:bg-zinc-800/60 disabled:cursor-not-allowed disabled:text-zinc-600"
                  >
                    ＋ 新会话
                  </button>
                  {sessions.length === 0 && (
                    <div className="border-t border-zinc-800/60 px-2.5 py-2 text-xs text-zinc-600">
                      暂无历史会话
                    </div>
                  )}
                  {sessions.map((s) => {
                    const active = s.id === sessionId
                    return (
                      <div
                        key={s.id}
                        className={`flex items-center gap-1 border-t border-zinc-800/60 px-1.5 py-1.5 ${
                          active ? 'bg-zinc-800/70' : ''
                        }`}
                      >
                        {renamingId === s.id ? (
                          <>
                            <input
                              // biome-ignore lint/a11y/noAutofocus: 会话重命名弹层打开时聚焦是预期交互
                              autoFocus
                              value={renameText}
                              onChange={(e) => setRenameText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  renameSession(s.id, renameText)
                                  setRenamingId(null)
                                } else if (e.key === 'Escape') {
                                  setRenamingId(null)
                                }
                              }}
                              className="min-w-0 flex-1 rounded border border-amber-600/60 bg-zinc-950 px-1.5 py-1 text-xs text-zinc-200 outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                renameSession(s.id, renameText)
                                setRenamingId(null)
                              }}
                              className="shrink-0 cursor-pointer rounded px-1.5 py-1 text-xs text-amber-400 hover:bg-zinc-800"
                            >
                              存
                            </button>
                          </>
                        ) : confirmDeleteId === s.id ? (
                          <>
                            <span className="min-w-0 flex-1 truncate px-1 text-xs text-red-300">
                              删除「{s.title}」？
                            </span>
                            <button
                              type="button"
                              onClick={() => deleteSessionById(s.id)}
                              className="shrink-0 cursor-pointer rounded px-1.5 py-1 text-xs text-red-400 hover:bg-zinc-800"
                            >
                              确认
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="shrink-0 cursor-pointer rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => switchSession(s.id)}
                              disabled={running || active}
                              className="min-w-0 flex-1 cursor-pointer rounded px-1 py-0.5 text-left disabled:cursor-default"
                            >
                              <div
                                className={`truncate text-xs ${
                                  active ? 'font-medium text-amber-400' : 'text-zinc-200'
                                }`}
                              >
                                {s.title}
                              </div>
                              <div className="text-[10px] text-zinc-500">
                                {fmtRelative(s.updatedAt)}
                              </div>
                            </button>
                            <button
                              type="button"
                              title="重命名"
                              onClick={() => {
                                setRenamingId(s.id)
                                setRenameText(s.title)
                              }}
                              className="shrink-0 cursor-pointer rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                            >
                              改
                            </button>
                            <button
                              type="button"
                              title="删除"
                              onClick={() => setConfirmDeleteId(s.id)}
                              disabled={running}
                              className="shrink-0 cursor-pointer rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              删
                            </button>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="w-[calc(50%-0.375rem)] sm:w-56">
          <div className="mb-1.5 text-xs font-medium text-zinc-400">模型</div>
          <Select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={running}
            className="w-full"
          >
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </div>
        <div className="sm:pt-5">
          <Badge tone="amber">可直接读写当前项目的各板块</Badge>
        </div>
        <div className="sm:ml-auto sm:pt-5">
          <Button variant="ghost" onClick={openInstructions}>
            指令
          </Button>
        </div>
      </div>

      <Card className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4">
          {turns.length === 0 && !running && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-600">
              <div>用自然语言指挥智能体编辑当前项目，例如：</div>
              <div className="text-xs leading-6 text-zinc-500">
                「看看现在有哪些人物，给林晚风补一段童年经历」
                <br />
                「把第 3 章大纲的结尾钩子改得更强」
                <br />
                「列出未回收的伏笔，把第 5 章埋的那条标记为已回收」
              </div>
              <div className="text-xs text-zinc-600">删除与覆盖正文等危险操作会先请求确认</div>
            </div>
          )}
          <div className="space-y-4">
            {turns.map((turn, idx) =>
              turn.role === 'user' ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: 追加式/一次性渲染列表，index 即身份，无重排语义
                <div key={idx} className="flex justify-end">
                  <div className="max-w-[75%] whitespace-pre-wrap rounded-lg bg-amber-600/90 px-3.5 py-2 text-sm leading-6 text-zinc-950">
                    {turn.text}
                  </div>
                </div>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: 追加式/一次性渲染列表，index 即身份，无重排语义
                <div key={idx} className="space-y-2">
                  {buildRenderItems(turn).map((item) =>
                    item.kind === 'text' ? (
                      <Markdown
                        key={item.key}
                        text={item.text}
                        className="text-sm leading-7 text-zinc-200"
                      />
                    ) : (
                      <ToolGroup
                        key={item.key}
                        calls={item.calls}
                        running={running}
                        confirmTargetId={confirmTarget?.id ?? null}
                        onResolve={resolveConfirm}
                        subProcs={subProcs}
                      />
                    )
                  )}
                </div>
              )
            )}
            {running && (
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                {confirmTarget ? '等待你的确认…' : '智能体工作中…'}
              </div>
            )}
          </div>
        </div>
        {showJump && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute bottom-4 right-5 z-10 cursor-pointer rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs text-zinc-300 shadow-lg transition-colors hover:border-amber-600/60 hover:text-amber-400"
          >
            ↓ 回到底部
          </button>
        )}
        {(doneInfo || error) && (
          <div className="border-t border-zinc-800 px-4 py-2.5">
            {error ? (
              <div className="text-sm text-red-400">{error}</div>
            ) : doneInfo ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-400">
                <span>
                  请求 <span className="font-mono text-zinc-200">{doneInfo.requests}</span> 次
                </span>
                <span>
                  输入{' '}
                  <span className="font-mono text-zinc-200">
                    {fmtTokens(doneInfo.usage.inputTokens)}
                  </span>
                </span>
                <span>
                  输出{' '}
                  <span className="font-mono text-zinc-200">
                    {fmtTokens(doneInfo.usage.outputTokens)}
                  </span>
                </span>
                {doneInfo.usage.cacheReadTokens > 0 && (
                  <span>
                    缓存读{' '}
                    <span className="font-mono text-emerald-400">
                      {fmtTokens(doneInfo.usage.cacheReadTokens)}
                    </span>
                  </span>
                )}
                <span>
                  耗时{' '}
                  <span className="font-mono text-zinc-200">
                    {fmtDuration(doneInfo.durationMs)}
                  </span>
                </span>
                {doneInfo.changed && <Badge tone="green">已修改资料库</Badge>}
                {doneInfo.denied && <Badge tone="amber">有操作被拒绝</Badge>}
                {doneInfo.hitLimit && <Badge tone="red">达到步数上限</Badge>}
                {doneInfo.subagents > 0 && (
                  <Badge tone="amber">子任务 {doneInfo.subagents} 次</Badge>
                )}
              </div>
            ) : null}
          </div>
        )}
      </Card>

      <div className="pb-[env(safe-area-inset-bottom)]">
        <Textarea
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send()
          }}
          placeholder="描述任务，Ctrl+Enter 发送，例如：帮我把主角的人物卡扩写到 500 字"
          disabled={running}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="hidden text-xs text-zinc-600 sm:inline">Ctrl+Enter 发送</span>
          <div className="flex gap-2">
            {running ? (
              <Button variant="danger" onClick={stop}>
                停止
              </Button>
            ) : (
              <Button onClick={send} disabled={!input.trim() || !model}>
                发送
              </Button>
            )}
          </div>
        </div>
      </div>

      <OverlayCard
        open={instrOpen}
        onClose={() => setInstrOpen(false)}
        title="智能体指令"
        widthClass="max-w-2xl"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-1.5">
            {(
              [
                ['global', '全局（agents.md）'],
                ['project', '本项目']
              ] as Array<['global' | 'project', string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setInstrTab(key)}
                className={`cursor-pointer rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  instrTab === key
                    ? 'border-amber-600/60 bg-amber-600/10 text-amber-400'
                    : 'border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-zinc-600">
              {instrTab === 'global'
                ? `存于 ${instr?.globalPath ?? '…'}，所有项目生效`
                : '仅当前项目的智能体生效，优先级高于全局'}
            </span>
          </div>
          <Textarea
            rows={14}
            value={instrDraft[instrTab]}
            onChange={(e) => setInstrDraft((d) => ({ ...d, [instrTab]: e.target.value }))}
            placeholder={
              instrTab === 'global'
                ? '跨项目的写作偏好、称谓、章节结构习惯…（Markdown）'
                : '本项目专属的工作要求，例如「伏笔必须三章内回收」…（Markdown）'
            }
            className="font-mono text-xs"
          />
          <div className="flex items-center gap-2">
            <Button onClick={saveInstructions} disabled={instrSaving}>
              {instrSaving ? '保存中…' : '保存'}
            </Button>
            {instrSaved && <span className="text-xs text-emerald-400">已保存，下次任务生效</span>}
            {instrErr && <span className="text-xs text-red-400">{instrErr}</span>}
          </div>
        </div>
      </OverlayCard>
    </div>
  )
}
