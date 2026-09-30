import type { AgentToolCallEvent, AgentToolResultEvent } from '@shared/contract'
import type {
  AgentDonePayload,
  AgentSession,
  AgentSessionBrief,
  AgentToolCall,
  AgentTurn
} from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Markdown } from '@mobile/components/Markdown'
import { Badge, Button, Empty, Textarea } from '@mobile/components/ui'
import { fmtRelative } from '@mobile/lib/format'
import { finalizeTurns, makeSessionTitle, toolLabel, toolSummary, turnsToMessages } from '@mobile/lib/agentTurns'

type AssistantTurn = Extract<AgentTurn, { role: 'assistant' }>

const STATE_DOT: Record<AgentToolCall['state'], string> = {
  running: 'bg-amber-500 animate-pulse',
  confirming: 'bg-red-500 animate-pulse',
  ok: 'bg-emerald-500',
  error: 'bg-red-600',
  denied: 'bg-zinc-500'
}

export default function AgentChat({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: sessions = [] } = useQuery({
    queryKey: ['agentSessions', projectId],
    queryFn: () => window.api.agent.sessions(projectId)
  })
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [turns, setTurns] = useState<AgentTurn[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const requestIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const sessionCreatedAtRef = useRef<number>(Date.now())
  const turnsRef = useRef<AgentTurn[]>([])
  const endRef = useRef<HTMLDivElement | null>(null)

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
      void window.api.agent.sessionSave(session).then(() => {
        void qc.invalidateQueries({ queryKey: ['agentSessions', projectId] })
      })
    },
    [projectId, qc]
  )

  // 切项目时中断并加载该项目最近会话
  useEffect(() => {
    if (requestIdRef.current) {
      void window.api.agent.abort(requestIdRef.current)
      requestIdRef.current = null
      setRunning(false)
    }
    if (!projectId) return
    void window.api.agent.sessions(projectId).then((list) => {
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
  }, [projectId, applyTurns, setSession, persist])

  useEffect(() => {
    const offDelta = window.api.agent.onDelta((id, text) => {
      if (id !== requestIdRef.current) return
      patchLastAssistant((t) => ({ ...t, text: t.text + text }))
    })
    const offToolCall = window.api.agent.onToolCall((id, call: AgentToolCallEvent) => {
      if (id !== requestIdRef.current) return
      patchLastAssistant((t) => ({
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
        ]
      }))
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
      const sid = sessionIdRef.current
      if (sid) persist(sid, turnsRef.current)
    })
    const offDone = window.api.agent.onDone((id, payload: AgentDonePayload) => {
      if (id !== requestIdRef.current) return
      const fixed = finalizeTurns(turnsRef.current)
      if (fixed.length > 0 && fixed[fixed.length - 1].role === 'assistant') {
        const last = fixed[fixed.length - 1] as AssistantTurn
        fixed[fixed.length - 1] = { ...last, text: payload.text || last.text }
      }
      applyTurns(fixed)
      const sid = sessionIdRef.current
      if (sid) persist(sid, fixed)
      setRunning(false)
      requestIdRef.current = null
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
    })
    return () => {
      offDelta()
      offToolCall()
      offToolResult()
      offDone()
      offError()
    }
  }, [applyTurns, patchLastAssistant, persist])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [turns])

  if (!projectId) return <Empty text="请先在「书架」选择项目" />

  const confirmTarget = (() => {
    if (!running || turns.length === 0) return null
    const last = turns[turns.length - 1]
    if (last.role !== 'assistant') return null
    return last.toolCalls.find((c) => c.state === 'confirming') ?? null
  })()

  const send = (): void => {
    if (!input.trim() || running) return
    const sid = sessionId ?? crypto.randomUUID()
    if (!sessionId) {
      setSession(sid)
      sessionCreatedAtRef.current = Date.now()
    }
    const next: AgentTurn[] = [
      ...turns,
      { role: 'user', text: input.trim(), ts: Date.now() },
      { role: 'assistant', text: '', toolCalls: [], ts: Date.now() }
    ]
    applyTurns(next)
    setInput('')
    setError('')
    persist(sid, next)
    void window.api.agent
      .run({ projectId, messages: turnsToMessages(next) })
      .then((id) => {
        requestIdRef.current = id
      })
      .catch((err: unknown) => {
        setError((err as Error).message)
        setRunning(false)
      })
    setRunning(true)
  }

  const stop = (): void => {
    if (requestIdRef.current) void window.api.agent.abort(requestIdRef.current)
  }

  const resolveConfirm = (allow: boolean, always: boolean): void => {
    if (!requestIdRef.current || !confirmTarget) return
    void window.api.agent.resolve(requestIdRef.current, confirmTarget.id, allow, always)
  }

  const switchSession = (id: string | null): void => {
    if (running) stop()
    requestIdRef.current = null
    setRunning(false)
    setPickerOpen(false)
    if (!id) {
      setSession(null)
      applyTurns([])
      setError('')
      return
    }
    void window.api.agent.sessionLoad(id).then((session) => {
      if (!session) return
      setSession(session.id)
      applyTurns(session.turns)
      sessionCreatedAtRef.current = session.createdAt
      setError('')
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/95 px-3 py-2">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="min-w-0 flex-1 cursor-pointer truncate rounded-lg bg-zinc-900 px-3 py-1.5 text-left text-xs text-zinc-300 active:bg-zinc-800"
        >
          {sessions.find((s) => s.id === sessionId)?.title ?? '新会话'}
        </button>
        <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => switchSession(null)}>
          新建
        </Button>
      </div>
      {pickerOpen && (
        <div className="max-h-56 overflow-y-auto border-b border-zinc-800 bg-zinc-900">
          {sessions.length === 0 && <div className="p-3 text-xs text-zinc-600">暂无历史会话</div>}
          {sessions.map((s: AgentSessionBrief) => (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              className={`cursor-pointer px-4 py-2.5 text-sm active:bg-zinc-800 ${s.id === sessionId ? 'text-amber-400' : 'text-zinc-300'}`}
              onClick={() => switchSession(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') switchSession(s.id)
              }}
            >
              <div className="truncate">{s.title}</div>
              <div className="text-[11px] text-zinc-600">{fmtRelative(s.updatedAt)}</div>
            </div>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {turns.length === 0 && <Empty text="给智能体下指令，例如「把第 3 章重写得更紧凑」" />}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-amber-600/90 px-3.5 py-2 text-sm leading-6 text-white">
                {t.text}
              </div>
            </div>
          ) : (
            <div key={i} className="space-y-2">
              {t.text && (
                <div className="rounded-2xl rounded-bl-md bg-zinc-900 px-3.5 py-2.5">
                  <Markdown text={t.text} className="text-sm leading-6 text-zinc-200" />
                </div>
              )}
              {t.toolCalls.map((c) => {
                const isConfirm = c.state === 'confirming' && c.id === confirmTarget?.id
                return (
                  <div
                    key={c.id}
                    className={`rounded-xl border bg-zinc-900/60 ${isConfirm ? 'border-red-800' : 'border-zinc-800'}`}
                  >
                    <div className="flex items-center gap-2 px-3 py-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[c.state]}`} />
                      <span className="shrink-0 font-mono text-[11px] text-amber-500/90">
                        {toolLabel(c.name)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">
                        {toolSummary(c)}
                      </span>
                    </div>
                    {isConfirm && (
                      <div className="space-y-2 border-t border-zinc-800 px-3 py-2.5">
                        <div className="text-xs leading-5 text-red-300">
                          ⚠ {c.dangerReason ?? '该操作不可恢复'}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button className="px-3 py-1.5 text-xs" onClick={() => resolveConfirm(true, false)}>
                            允许
                          </Button>
                          <Button
                            variant="ghost"
                            className="px-3 py-1.5 text-xs"
                            onClick={() => resolveConfirm(true, true)}
                          >
                            本次任务内不再询问
                          </Button>
                          <Button variant="danger" className="px-3 py-1.5 text-xs" onClick={() => resolveConfirm(false, false)}>
                            拒绝
                          </Button>
                        </div>
                      </div>
                    )}
                    {c.result !== undefined && !isConfirm && (
                      <details className="border-t border-zinc-800 px-3 py-2">
                        <summary className="cursor-pointer text-[11px] text-zinc-500">查看结果</summary>
                        <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-[11px] leading-4 text-zinc-400">
                          {c.result}
                        </pre>
                      </details>
                    )}
                  </div>
                )
              })}
            </div>
          )
        )}
        {error && (
          <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs leading-5 text-red-300">
            {error}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="flex items-end gap-2 border-t border-zinc-800 bg-zinc-950/95 p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={1}
          className="max-h-32 min-h-11 flex-1 py-2.5"
          placeholder={running ? '智能体工作中…' : '输入指令…'}
          disabled={running}
        />
        {running ? (
          <Button variant="danger" className="shrink-0 px-3.5" onClick={stop}>
            停止
          </Button>
        ) : (
          <Button className="shrink-0 px-3.5" disabled={!input.trim()} onClick={send}>
            发送
          </Button>
        )}
      </div>
      {running && (
        <div className="flex items-center justify-center gap-1.5 border-t border-zinc-900 py-1">
          <Badge className="bg-amber-600/15 text-amber-400">运行中</Badge>
        </div>
      )}
    </div>
  )
}
