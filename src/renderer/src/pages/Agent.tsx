import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentDonePayload,
  AgentSession,
  AgentSessionBrief,
  AgentToolCall,
  AgentTurn,
  ModelProbeResult,
  SettingsView
} from '@shared/types'
import { Markdown } from '../components/Markdown'
import { Badge, Button, Card, Select, Textarea } from '../components/ui'
import { fmtDuration, fmtTokens } from '../lib/format'
import { makeSessionTitle, toolLabel, toolSummary, turnsToMessages } from '../lib/agentTurns'
import type { AgentToolCallEvent, AgentToolResultEvent } from '../../../preload/index'

type AssistantTurn = Extract<AgentTurn, { role: 'assistant' }>

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
  onResolve
}: {
  call: AgentToolCall
  canResolve: boolean
  onResolve: (allow: boolean, always: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/60">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[call.state]}`} />
        <span className="shrink-0 font-mono text-[11px] text-amber-500/90">{toolLabel(call.name)}</span>
        <span className="flex-1 truncate text-xs text-zinc-300">{toolSummary(call)}</span>
        <span className="shrink-0 text-[10px] text-zinc-500">{STATE_LABEL[call.state]}</span>
      </button>
      {call.state === 'confirming' && canResolve && (
        <div className="border-t border-zinc-800 px-3 py-2.5">
          <div className="text-xs leading-5 text-red-300">⚠ {call.dangerReason ?? '该操作不可恢复'}</div>
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

export default function Agent({ projectId }: { projectId: string }) {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [probe, setProbe] = useState<ModelProbeResult | null>(null)
  const [model, setModel] = useState('')
  const [sessions, setSessions] = useState<AgentSessionBrief[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [turns, setTurns] = useState<AgentTurn[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [doneInfo, setDoneInfo] = useState<AgentDonePayload | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const sessionCreatedAtRef = useRef<number>(Date.now())
  const turnsRef = useRef<AgentTurn[]>([])
  const endRef = useRef<HTMLDivElement>(null)

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

  const refreshSessions = useCallback((pid: string): void => {
    void window.api.agent.sessions(pid).then(setSessions)
  }, [])

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
    }
    if (!projectId) return
    void (async () => {
      const s = await window.api.settings.get()
      setSettings(s)
      setModel(s.modelRouting.agent || s.defaultModel)
      try {
        setProbe(await window.api.models.probe())
      } catch {
        setProbe(null)
      }
    })()
    void window.api.agent.sessions(projectId).then((list) => {
      setSessions(list)
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
  }, [projectId, applyTurns, setSession])

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
          { id: call.id, name: call.name, input: call.input, state: call.state, dangerReason: call.dangerReason }
        ]
      }))
    })
    const offToolResult = window.api.agent.onToolResult((id, r: AgentToolResultEvent) => {
      if (id !== requestIdRef.current) return
      patchLastAssistant((t) => ({
        ...t,
        toolCalls: t.toolCalls.map((c) =>
          c.id === r.id
            ? { ...c, state: (r.denied ? 'denied' : r.ok ? 'ok' : 'error') as AgentToolCall['state'], result: r.result }
            : c
        )
      }))
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

  const modelOptions = (() => {
    const ids = new Set<string>()
    if (probe) probe.models.forEach((m) => ids.add(m))
    settings?.customModels
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((m) => ids.add(m))
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
      { role: 'assistant', text: '', toolCalls: [], ts }
    ]
    applyTurns(next)
    setInput('')
    setError('')
    setDoneInfo(null)
    setRunning(true)
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

  const switchSession = (id: string): void => {
    if (running) stop()
    if (!id) {
      setSession(null)
      applyTurns([])
      setError('')
      setDoneInfo(null)
      return
    }
    void window.api.agent.sessionLoad(id).then((session) => {
      if (!session) return
      setSession(session.id)
      applyTurns(session.turns)
      sessionCreatedAtRef.current = session.createdAt
      setError('')
      setDoneInfo(null)
    })
  }

  const deleteSession = (): void => {
    if (!sessionId) return
    void window.api.agent.sessionDelete(sessionId).then(() => {
      setSession(null)
      applyTurns([])
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
        <div className="w-full sm:w-56">
          <div className="mb-1.5 text-xs font-medium text-zinc-400">会话</div>
          <div className="flex gap-1.5">
            <Select
              value={sessionId ?? ''}
              onChange={(e) => switchSession(e.target.value)}
              disabled={running}
              className="min-w-0 flex-1"
            >
              <option value="">＋ 新会话</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </Select>
            {sessionId && !running && (
              <Button variant="ghost" onClick={deleteSession} title="删除当前会话">
                删
              </Button>
            )}
          </div>
        </div>
        <div className="w-full sm:w-56">
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
        <div className="pt-5">
          <Badge tone="amber">可直接读写当前项目的各板块</Badge>
        </div>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4">
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
                <div key={idx} className="flex justify-end">
                  <div className="max-w-[75%] whitespace-pre-wrap rounded-lg bg-amber-600/90 px-3.5 py-2 text-sm leading-6 text-zinc-950">
                    {turn.text}
                  </div>
                </div>
              ) : (
                <div key={idx} className="space-y-2">
                  {turn.text && (
                    <Markdown text={turn.text} className="text-sm leading-7 text-zinc-200" />
                  )}
                  {turn.toolCalls.map((call) => (
                    <ToolCallCard
                      key={call.id}
                      call={call}
                      canResolve={running && call.id === confirmTarget?.id}
                      onResolve={resolveConfirm}
                    />
                  ))}
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
          <div ref={endRef} />
        </div>
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
                  输入 <span className="font-mono text-zinc-200">{fmtTokens(doneInfo.usage.inputTokens)}</span>
                </span>
                <span>
                  输出 <span className="font-mono text-zinc-200">{fmtTokens(doneInfo.usage.outputTokens)}</span>
                </span>
                {doneInfo.usage.cacheReadTokens > 0 && (
                  <span>
                    缓存读 <span className="font-mono text-emerald-400">{fmtTokens(doneInfo.usage.cacheReadTokens)}</span>
                  </span>
                )}
                <span>
                  耗时 <span className="font-mono text-zinc-200">{fmtDuration(doneInfo.durationMs)}</span>
                </span>
                {doneInfo.changed && <Badge tone="green">已修改资料库</Badge>}
                {doneInfo.denied && <Badge tone="amber">有操作被拒绝</Badge>}
                {doneInfo.hitLimit && <Badge tone="red">达到步数上限</Badge>}
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
    </div>
  )
}
