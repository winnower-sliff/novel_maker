import type { AgentInstructionsView, AgentToolCall, AgentTurn } from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useBackHandler } from '@mobile/lib/backHandler'
import { Markdown } from '@mobile/components/Markdown'
import { Badge, Button, Empty, Textarea } from '@mobile/components/ui'
import { fmtRelative } from '@mobile/lib/format'
import { findCompactPoint, toolLabel, toolSummary } from '@mobile/lib/agentTurns'
import {
  resolveConfirm,
  startRun,
  stopRun,
  switchSession as switchSessionRun,
  syncProject,
  useAgentConfirmTarget,
  useAgentRunStore
} from '@wizard/agentRunStore'
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
  const [input, setInput] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [instrOpen, setInstrOpen] = useState(false)
  const [instrTab, setInstrTab] = useState<'global' | 'project'>('global')
  const [instr, setInstr] = useState<AgentInstructionsView | null>(null)
  const [instrDraft, setInstrDraft] = useState({ global: '', project: '' })
  const [instrSaving, setInstrSaving] = useState(false)
  const [instrSaved, setInstrSaved] = useState(false)
  const [instrErr, setInstrErr] = useState('')
  const [showJump, setShowJump] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  // 会话选择器打开时，返回键先关闭它
  useBackHandler(useCallback(() => setPickerOpen(false), []), pickerOpen)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)

  // 运行态（turns/running/error/session）全在 agentRunStore（模块级），
  // 切 tab 卸载本组件不断流；hooks 必须全部位于下方 early return 之前
  const turns = useAgentRunStore((s) => s.turns)
  const running = useAgentRunStore((s) => s.running)
  const error = useAgentRunStore((s) => s.error)
  const errorHint = useAgentRunStore((s) => s.errorHint)
  const sessionId = useAgentRunStore((s) => s.sessionId)
  const confirmTarget = useAgentConfirmTarget()

  // 项目变化：中断旧任务并加载新项目最近会话（同项目重复挂载为幂等 no-op）
  // 项目对账：运行中被守卫推迟后，收尾时靠 running 变化重触发补对账
  useEffect(() => {
    syncProject(projectId)
  }, [projectId, running])

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

  const send = (): void => {
    if (!input.trim() || running) return
    startRun(input)
    setInput('')
    atBottomRef.current = true
    setShowJump(false)
  }

  const stop = (): void => {
    stopRun()
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

  const handleSwitchSession = (id: string | null): void => {
    switchSessionRun(id)
    setPickerOpen(false)
    setHistoryOpen(false)
    atBottomRef.current = true
    setShowJump(false)
  }

  const compactPoint = findCompactPoint(turns)

  const renderTurn = (turn: AgentTurn, idx: number) =>
    turn.role === 'user' ? (
      <div key={idx} className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-amber-600/90 px-3.5 py-2 text-sm leading-6 text-white">
          {turn.text}
        </div>
      </div>
    ) : (
      <div key={idx} className="space-y-2">
        {buildRenderItems(turn).map((item) =>
          item.kind === 'text' ? (
            <div key={item.key} className="rounded-2xl rounded-bl-md bg-zinc-900 px-3.5 py-2.5">
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
        <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => handleSwitchSession(null)}>
          新建
        </Button>
        <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={openInstructions}>
          指令
        </Button>
      </div>
      {pickerOpen && (
        <div className="max-h-56 overflow-y-auto border-b border-zinc-800 bg-zinc-900">
          {sessions.length === 0 && <div className="p-3 text-xs text-zinc-600">暂无历史会话</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              className={`cursor-pointer px-4 py-2.5 text-sm active:bg-zinc-800 ${s.id === sessionId ? 'text-amber-400' : 'text-zinc-300'}`}
              onClick={() => handleSwitchSession(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSwitchSession(s.id)
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
          {compactPoint && historyOpen &&
            turns.slice(0, compactPoint.index + 1).map((t, i) => renderTurn(t, i))}
          {compactPoint && (
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="w-full cursor-pointer rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-left active:bg-zinc-800"
            >
              <div className="text-xs font-medium text-zinc-400">
                已压缩历史（{compactPoint.index + 1} 轮对话{historyOpen ? '，点击收起' : ''}）
              </div>
              <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-zinc-500">
                {compactPoint.summary}
              </div>
            </button>
          )}
          {(compactPoint ? turns.slice(compactPoint.index + 1) : turns).map((t, i) =>
            renderTurn(t, i)
          )}
          {error && (
            <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs leading-5 text-red-300">
              {errorHint?.friendly || error}
              {errorHint?.friendly && (
                <details className="mt-1">
                  <summary className="cursor-pointer select-none text-zinc-500">详细信息</summary>
                  <div className="mt-1 break-all font-mono text-zinc-500">{error}</div>
                </details>
              )}
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
