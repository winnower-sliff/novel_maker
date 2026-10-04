import type { AgentToolCallEvent, AgentToolResultEvent } from '@shared/contract'
import type {
  AgentDonePayload,
  AgentInstructionsView,
  AgentSession,
  AgentSessionBrief,
  AgentToolCall,
  AgentTurn
} from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useBackHandler } from '@mobile/lib/backHandler'
import { Markdown } from '@mobile/components/Markdown'
import { Badge, Button, Empty, Textarea } from '@mobile/components/ui'
import { fmtRelative } from '@mobile/lib/format'
import { finalizeTurns, makeSessionTitle, toolLabel, toolSummary, turnsToMessages } from '@mobile/lib/agentTurns'
import { OverlayCard } from '@wizard/OverlayCard'

type AssistantTurn = Extract<AgentTurn, { role: 'assistant' }>

const STATE_DOT: Record<AgentToolCall['state'], string> = {
  running: 'bg-amber-500 animate-pulse',
  confirming: 'bg-red-500 animate-pulse',
  ok: 'bg-emerald-500',
  error: 'bg-red-600',
  denied: 'bg-zinc-500'
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

function MobileToolCard({
  call,
  isConfirm,
  onResolve
}: {
  call: AgentToolCall
  isConfirm: boolean
  onResolve: (allow: boolean, always: boolean) => void
}) {
  return (
    <div
      className={`rounded-xl border bg-zinc-900/60 ${isConfirm ? 'border-red-800' : 'border-zinc-800'}`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[call.state]}`} />
        <span className="shrink-0 font-mono text-[11px] text-amber-500/90">{toolLabel(call.name)}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{toolSummary(call)}</span>
      </div>
      {isConfirm && (
        <div className="space-y-2 border-t border-zinc-800 px-3 py-2.5">
          <div className="text-xs leading-5 text-red-300">⚠ {call.dangerReason ?? '该操作不可恢复'}</div>
          <div className="flex flex-wrap gap-2">
            <Button className="px-3 py-1.5 text-xs" onClick={() => onResolve(true, false)}>
              允许
            </Button>
            <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => onResolve(true, true)}>
              本次任务内不再询问
            </Button>
            <Button variant="danger" className="px-3 py-1.5 text-xs" onClick={() => onResolve(false, false)}>
              拒绝
            </Button>
          </div>
        </div>
      )}
      {call.result !== undefined && !isConfirm && (
        <details className="border-t border-zinc-800 px-3 py-2">
          <summary className="cursor-pointer text-[11px] text-zinc-500">查看结果</summary>
          <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-[11px] leading-4 text-zinc-400">
            {call.result}
          </pre>
        </details>
      )}
    </div>
  )
}

function MobileToolGroup({
  calls,
  confirmTargetId,
  onResolve
}: {
  calls: AgentToolCall[]
  confirmTargetId: string | null
  onResolve: (allow: boolean, always: boolean) => void
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
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className="shrink-0 font-mono text-[11px] text-amber-500/70">工具 × {calls.length}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">
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
          {calls.map((c) => (
            <MobileToolCard
              key={c.id}
              call={c}
              isConfirm={c.state === 'confirming' && c.id === confirmTargetId}
              onResolve={onResolve}
            />
          ))}
        </div>
      )}
    </div>
  )
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
  const [instrOpen, setInstrOpen] = useState(false)
  const [instrTab, setInstrTab] = useState<'global' | 'project'>('global')
  const [instr, setInstr] = useState<AgentInstructionsView | null>(null)
  const [instrDraft, setInstrDraft] = useState({ global: '', project: '' })
  const [instrSaving, setInstrSaving] = useState(false)
  const [instrSaved, setInstrSaved] = useState(false)
  const [instrErr, setInstrErr] = useState('')
  const [showJump, setShowJump] = useState(false)
  // 会话选择器打开时，返回键先关闭它
  useBackHandler(useCallback(() => setPickerOpen(false), []), pickerOpen)
  const requestIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const sessionCreatedAtRef = useRef<number>(Date.now())
  const turnsRef = useRef<AgentTurn[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)
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

  // 键盘弹出/收起（--kb 变化挤压聊天区）后，跟随底部时保持滚到底部
  useEffect(() => {
    const onKb = (): void => {
      const el = scrollRef.current
      if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
    }
    window.addEventListener('nm-kb', onKb)
    return () => window.removeEventListener('nm-kb', onKb)
  }, [])

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
      { role: 'assistant', text: '', toolCalls: [], segments: [], ts: Date.now() }
    ]
    applyTurns(next)
    setInput('')
    setError('')
    atBottomRef.current = true
    setShowJump(false)
    cancelPendingDelta()
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
        void qc.invalidateQueries({ queryKey: ['novel', 'projects'] })
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

  const switchSession = (id: string | null): void => {
    if (running) stop()
    requestIdRef.current = null
    setRunning(false)
    setPickerOpen(false)
    atBottomRef.current = true
    setShowJump(false)
    cancelPendingDelta()
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
    <div className="flex h-full flex-col pb-[var(--kb,0px)]">
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
        <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={openInstructions}>
          指令
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

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleScroll} className="h-full space-y-3 overflow-y-auto p-3">
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
                {buildRenderItems(t).map((item) =>
                  item.kind === 'text' ? (
                    <div
                      key={item.key}
                      className="rounded-2xl rounded-bl-md bg-zinc-900 px-3.5 py-2.5"
                    >
                      <Markdown text={item.text} className="text-sm leading-6 text-zinc-200" />
                    </div>
                  ) : (
                    <MobileToolGroup
                      key={item.key}
                      calls={item.calls}
                      confirmTargetId={confirmTarget?.id ?? null}
                      onResolve={resolveConfirm}
                    />
                  )
                )}
              </div>
            )
          )}
          {error && (
            <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs leading-5 text-red-300">
              {error}
            </div>
          )}
        </div>
        {showJump && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute bottom-3 right-4 z-10 rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs text-zinc-300 shadow-lg active:border-amber-600/60"
          >
            ↓ 回到底部
          </button>
        )}
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

      <OverlayCard
        open={instrOpen}
        onClose={() => setInstrOpen(false)}
        title="智能体指令"
        fullscreenOnMobile
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
                    : 'border-zinc-800 text-zinc-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-4 text-zinc-600">
            {instrTab === 'global'
              ? '存于电脑端 userData/agents.md，所有项目生效'
              : '仅当前项目的智能体生效，优先级高于全局'}
          </p>
          <Textarea
            rows={12}
            value={instrDraft[instrTab]}
            onChange={(e) => setInstrDraft((d) => ({ ...d, [instrTab]: e.target.value }))}
            placeholder={
              instrTab === 'global'
                ? '跨项目的写作偏好、称谓、章节结构习惯…（Markdown）'
                : '本项目专属的工作要求…（Markdown）'
            }
          />
          <div className="flex items-center gap-2">
            <Button onClick={saveInstructions} disabled={instrSaving} className="px-4 py-2 text-xs">
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
