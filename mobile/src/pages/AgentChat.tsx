import type { AgentToolCall, AgentTurn } from '@shared/types'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useBackHandler } from '@mobile/lib/backHandler'
import { Markdown } from '@mobile/components/Markdown'
import { Badge, Button, Empty, Textarea } from '@mobile/components/ui'
import { fmtRelative } from '@mobile/lib/format'
import { findCompactPoint, toolLabel, toolSummary } from '@mobile/lib/agentTurns'
import { qk } from '@renderer/lib/queries'
import {
  cancelQueued,
  queueRun,
  resolveConfirm,
  retryLoadActive,
  startRun,
  stopRun,
  switchSession as switchSessionRun,
  syncProject,
  useAgentConfirmTarget,
  useAgentRunStore
} from '@wizard/agentRunStore'
import { useAgentTabsStore } from '@wizard/agentTabsStore'
import { AgentInstructionsPanel } from '@wizard/AgentInstructionsPanel'
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
  const { data: sessions = [] } = useQuery({
    queryKey: qk.agentSessions(projectId),
    queryFn: () => window.api.agent.sessions(projectId)
  })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [instrOpen, setInstrOpen] = useState(false)
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
  const loadFailed = useAgentRunStore((s) => s.loadFailed)
  const runningIds = useAgentRunStore((s) => s.runningIds)
  const confirmTarget = useAgentConfirmTarget()

  // tab 会话模型：每项目一组 tab（含至多一个草稿 tab），草稿/滚动随 tab 保留
  const tabsState = useAgentTabsStore((s) => s.byProject[projectId])
  const activeKey = tabsState?.activeKey ?? ''
  const tabs = tabsState?.tabs ?? []
  const input = useAgentTabsStore((s) => (activeKey ? s.drafts[activeKey] ?? '' : ''))
  const queuedNext = useAgentRunStore((s) => s.queuedNext)

  // 输入框自动增高（内容超过上限后内部滚动）
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: input/activeKey 是故意的重触发信号（内容变化/切 tab 恢复草稿时重算高度）
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    // 挂载首帧 CSS/布局未就绪时 scrollHeight 可能为 0，误设 0px 后空输入不再触发重算——跳过保持自然高度
    const h = el.scrollHeight
    el.style.height = h > 0 ? `${Math.min(h, 128)}px` : ''
  }, [input, activeKey])

  // 项目变化：不中断旧任务，加载新项目最近会话（同项目重复挂载为幂等 no-op）
  useEffect(() => {
    syncProject(projectId)
    useAgentTabsStore.getState().ensure(projectId)
  }, [projectId, running])

  // active tab 跟随运行 store 的会话（草稿起步建会话/项目恢复对账）
  useEffect(() => {
    useAgentTabsStore.getState().syncActiveSession(projectId, sessionId)
  }, [projectId, sessionId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: dep 仅作重触发信号，加入会破坏语义
  useEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [turns])

  // 切 tab 恢复该 tab 的滚动位置（无记录则贴底）
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !activeKey) return
    const saved = useAgentTabsStore.getState().scrolls[activeKey]
    if (saved !== undefined) {
      el.scrollTop = saved
      atBottomRef.current = false
      setShowJump(true)
    } else {
      el.scrollTop = el.scrollHeight
      atBottomRef.current = true
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 tab 切换时执行
  }, [activeKey])

  const saveScroll = useCallback((): void => {
    const el = scrollRef.current
    if (el && activeKey) useAgentTabsStore.getState().setScroll(activeKey, el.scrollTop)
  }, [activeKey])

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

  const tabTitle = (sid: string | null): string =>
    sid ? (sessions.find((s) => s.id === sid)?.title ?? '会话') : '新会话'
  const tabBusy = (sid: string | null, key: string): boolean =>
    sid ? runningIds.includes(sid) : key === activeKey && running

  const activateTab = (key: string, sid: string | null): void => {
    saveScroll()
    useAgentTabsStore.getState().setActive(projectId, key)
    switchSessionRun(sid)
    setPickerOpen(false)
  }

  const closeTab = (key: string): void => {
    saveScroll()
    useAgentTabsStore.getState().closeTab(projectId, key)
    const st = useAgentTabsStore.getState().byProject[projectId]
    const next = st?.tabs.find((t) => t.key === st.activeKey)
    if (key === activeKey) switchSessionRun(next?.sessionId ?? null)
  }

  const newDraft = (): void => {
    saveScroll()
    const st = useAgentTabsStore.getState()
    const cur = st.byProject[projectId]
    const draft = cur?.tabs.find((t) => t.sessionId === null)
    if (draft && draft.key === cur?.activeKey) return
    if (draft) {
      st.setActive(projectId, draft.key)
    } else {
      st.newDraftTab(projectId)
    }
    switchSessionRun(null)
    setHistoryOpen(false)
  }

  const openSession = (id: string): void => {
    saveScroll()
    useAgentTabsStore.getState().openTab(projectId, id)
    switchSessionRun(id)
    setPickerOpen(false)
    setHistoryOpen(false)
  }

  const send = (): void => {
    const text = input.trim()
    if (!text) return
    if (running) {
      // 运行中：入队（已有排队时按钮已禁用，此处防御）
      if (queuedNext) return
      queueRun(text)
    } else {
      startRun(input)
    }
    if (activeKey) useAgentTabsStore.getState().setDraft(activeKey, '')
    atBottomRef.current = true
    setShowJump(false)
  }

  const cancelQueue = (): void => {
    const text = cancelQueued()
    if (text !== null && activeKey) useAgentTabsStore.getState().setDraft(activeKey, text)
  }

  const stop = (): void => {
    stopRun()
  }

  const compactPoint = findCompactPoint(turns)
  // 运行中不折叠压缩前的历史，只插分隔条；run 结束/静态加载才折叠
  const liveHistory = !!compactPoint && running

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
      <div className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-950/95 px-2 py-1.5">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
          {tabs.map((t) => {
            const active = t.key === activeKey
            const busy = tabBusy(t.sessionId, t.key)
            return (
              <div
                key={t.key}
                className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 ${
                  active
                    ? 'border-amber-600/60 bg-amber-600/10'
                    : 'border-zinc-800 bg-zinc-900 active:bg-zinc-800'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${busy ? 'animate-pulse bg-amber-500' : 'bg-zinc-600'}`}
                />
                <button
                  type="button"
                  onClick={() => activateTab(t.key, t.sessionId)}
                  className="max-w-24 cursor-pointer truncate text-xs text-zinc-200"
                >
                  {tabTitle(t.sessionId)}
                </button>
                <button
                  type="button"
                  aria-label="关闭标签"
                  onClick={() => closeTab(t.key)}
                  className="cursor-pointer rounded-full p-0.5 text-zinc-500 active:bg-zinc-800 active:text-zinc-300"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-3 w-3"
                  >
                    <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            )
          })}
        </div>
        <Button variant="ghost" className="shrink-0 px-2 py-1 text-xs" onClick={newDraft}>
          ＋
        </Button>
        <Button
          variant="ghost"
          className="shrink-0 px-2 py-1 text-xs"
          onClick={() => setPickerOpen((v) => !v)}
        >
          列表
        </Button>
        <Button
          variant="ghost"
          className="shrink-0 px-2 py-1 text-xs"
          onClick={() => setInstrOpen(true)}
        >
          指令
        </Button>
      </div>
      {pickerOpen && (
        <div className="max-h-64 overflow-y-auto border-b border-zinc-800 bg-zinc-900">
          {sessions.length === 0 && <div className="p-3 text-xs text-zinc-600">暂无历史会话</div>}
          {sessions.map((s) => {
            const busy = runningIds.includes(s.id)
            return (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                className={`cursor-pointer px-4 py-2.5 text-sm active:bg-zinc-800 ${
                  s.id === sessionId ? 'text-amber-400' : 'text-zinc-300'
                }`}
                onClick={() => openSession(s.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') openSession(s.id)
                }}
              >
                <div className="flex items-center gap-2">
                  {busy && <Badge className="bg-amber-600/15 text-amber-400">运行中</Badge>}
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                </div>
                <div className="text-[11px] text-zinc-600">{fmtRelative(s.updatedAt)}</div>
              </div>
            )
          })}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleScroll} className="h-full space-y-3 overflow-y-auto p-3">
          {turns.length === 0 && <Empty text="给智能体下指令，例如「把第 3 章重写得更紧凑」" />}
          {compactPoint &&
            (liveHistory || historyOpen) &&
            turns.slice(0, compactPoint.index + 1).map((t, i) => renderTurn(t, i))}
          {compactPoint && liveHistory && (
            <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/60 px-3 py-2">
              <div className="text-xs text-zinc-400">
                ⇡ 以上 {compactPoint.index + 1} 轮已压缩进摘要（任务运行中，暂不折叠）
              </div>
              <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-zinc-500">
                {compactPoint.summary}
              </div>
            </div>
          )}
          {compactPoint && !liveHistory && (
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
              {loadFailed && (
                <div className="mt-2">
                  <Button variant="ghost" className="px-3 py-1 text-xs" onClick={retryLoadActive}>
                    重试
                  </Button>
                </div>
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

      {queuedNext && (
        <div className="flex items-center gap-2 border-t border-amber-900/40 bg-amber-950/30 px-3 py-1.5 text-xs text-amber-300">
          <span className="shrink-0">已排队</span>
          <span className="min-w-0 flex-1 truncate text-amber-200/80">{queuedNext.text}</span>
          <button
            type="button"
            onClick={cancelQueue}
            className="shrink-0 rounded px-1.5 py-0.5 text-amber-400 active:bg-amber-900/40"
          >
            取消
          </button>
        </div>
      )}
      <div className="flex items-end gap-2 border-t border-zinc-800 bg-zinc-950/95 p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
        <Textarea
          ref={taRef}
          value={input}
          onChange={(e) => {
            if (activeKey) useAgentTabsStore.getState().setDraft(activeKey, e.target.value)
          }}
          rows={1}
          className="max-h-32 min-h-11 flex-1 py-2.5"
          placeholder={running ? '可继续输入，排队完成后自动发送…' : '输入指令…'}
        />
        {running && (
          <Button variant="danger" className="shrink-0 px-3.5" onClick={stop}>
            停止
          </Button>
        )}
        <Button
          className="shrink-0 px-3.5"
          disabled={!input.trim() || (!!queuedNext && running)}
          onClick={send}
        >
          {running ? '排队' : '发送'}
        </Button>
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
        <AgentInstructionsPanel projectId={projectId} />
      </OverlayCard>
    </div>
  )
}
