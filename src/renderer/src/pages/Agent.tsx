import type {
  AgentToolCall,
  AgentTurn,
  LlmErrorHint,
  ModelProbeResult,
  SettingsView
} from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { AgentInstructionsPanel } from '../../../wizard/AgentInstructionsPanel'
import type { SubProc } from '../../../wizard/agentRunStore'
import {
  cancelQueued,
  queueRun,
  renameSessionTitle,
  resolveConfirm,
  retryLoadActive,
  startRun,
  stopRun,
  switchSession as switchSessionRun,
  syncProject,
  useAgentConfirmTarget,
  useAgentRunStore
} from '../../../wizard/agentRunStore'
import { useAgentTabsStore } from '../../../wizard/agentTabsStore'
import { Markdown } from '../components/Markdown'
import { OverlayCard } from '../components/OverlayCard'
import { Badge, Button, Card, Select, Textarea } from '../components/ui'
import { findCompactPoint, toolLabel, toolSummary } from '../lib/agentTurns'
import { fmtDuration, fmtRelative, fmtTokens } from '../lib/format'
import { qk, queries } from '../lib/queries'

type AssistantTurn = Extract<AgentTurn, { role: 'assistant' }>

/** 错误提示块：有分类 hint 时 friendly 主行 + 原始报错折叠小字；无则原样展示 */
function ErrorHintBlock({ message, hint }: { message: string; hint: LlmErrorHint | null }) {
  const friendly = hint?.friendly
  if (!friendly) return <div className="text-sm text-red-400">{message}</div>
  return (
    <div className="text-sm text-red-400">
      <div>{friendly}</div>
      <details className="mt-1">
        <summary className="cursor-pointer select-none text-xs text-zinc-500 hover:text-zinc-400">
          详细信息
        </summary>
        <div className="mt-1 break-all font-mono text-xs leading-relaxed text-zinc-500">
          {message}
        </div>
      </details>
    </div>
  )
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
  const [panelOpen, setPanelOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [instrOpen, setInstrOpen] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  // 运行态（turns/running/error/doneInfo/subProcs/session）全在 agentRunStore，
  // 切页回来原样恢复；这里只做项目对账与模型选择数据加载
  const turns = useAgentRunStore((s) => s.turns)
  const running = useAgentRunStore((s) => s.running)
  const error = useAgentRunStore((s) => s.error)
  const errorHint = useAgentRunStore((s) => s.errorHint)
  const doneInfo = useAgentRunStore((s) => s.doneInfo)
  const subProcs = useAgentRunStore((s) => s.subProcs)
  const sessionId = useAgentRunStore((s) => s.sessionId)
  const loadFailed = useAgentRunStore((s) => s.loadFailed)
  const runningIds = useAgentRunStore((s) => s.runningIds)
  const queuedNext = useAgentRunStore((s) => s.queuedNext)
  const confirmTarget = useAgentConfirmTarget()

  // tab 会话模型：每项目一组 tab（含至多一个草稿 tab），草稿/滚动随 tab 保留
  const tabsState = useAgentTabsStore((s) => s.byProject[projectId])
  const activeKey = tabsState?.activeKey ?? ''
  const tabs = tabsState?.tabs ?? []
  const input = useAgentTabsStore((s) => (activeKey ? (s.drafts[activeKey] ?? '') : ''))

  // 触屏设备（平板等）回车兜底为换行，发送只走按钮
  const [coarsePointer] = useState(() => window.matchMedia?.('(pointer: coarse)').matches ?? false)
  // 输入框自动增高（内容超过上限后内部滚动）
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: input/activeKey 是故意的重触发信号（内容变化/切 tab 恢复草稿时重算高度）
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    // 挂载首帧 CSS/布局未就绪时 scrollHeight 可能为 0，误设 0px 后空输入不再触发重算——跳过保持自然高度
    const h = el.scrollHeight
    el.style.height = h > 0 ? `${Math.min(h, 192)}px` : ''
  }, [input, activeKey])

  const refreshSessions = (pid: string): void => {
    void queryClient.invalidateQueries({ queryKey: qk.agentSessions(pid) })
  }

  // 项目对账：运行中（含恢复接管）被 syncProject 守卫推迟后，收尾时靠 running 变化重触发补对账
  // biome-ignore lint/correctness/useExhaustiveDependencies: running 是故意的重触发信号（收尾时补对账）
  useEffect(() => {
    syncProject(projectId)
    useAgentTabsStore.getState().ensure(projectId)
  }, [projectId, running])

  // active tab 跟随运行 store 的会话（草稿起步建会话/项目恢复对账）
  useEffect(() => {
    useAgentTabsStore.getState().syncActiveSession(projectId, sessionId)
  }, [projectId, sessionId])

  // 项目变化：加载模型配置与失效会话列表（同一项目重复挂载为幂等 no-op）
  useEffect(() => {
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
    })()
    try {
      void window.api.models
        .probe({})
        .then(setProbe)
        .catch(() => setProbe(null))
    } catch {
      setProbe(null)
    }
    void queryClient.invalidateQueries({ queryKey: qk.agentSessions(projectId) })
  }, [projectId, queryClient])

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
  }, [activeKey])

  const saveScroll = (): void => {
    const el = scrollRef.current
    if (el && activeKey) useAgentTabsStore.getState().setScroll(activeKey, el.scrollTop)
  }

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

  const send = (): void => {
    const text = input.trim()
    if (!text || !model) return
    if (running) {
      // 运行中：入队（已有排队时按钮已禁用，此处防御）
      if (queuedNext) return
      queueRun(text, model)
    } else {
      startRun(input, model)
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

  const activateTab = (key: string, sid: string | null): void => {
    saveScroll()
    useAgentTabsStore.getState().setActive(projectId, key)
    switchSessionRun(sid)
    setPanelOpen(false)
    setRenamingId(null)
    setConfirmDeleteId(null)
    setHistoryOpen(false)
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
    if (!(draft && draft.key === cur?.activeKey)) {
      if (draft) st.setActive(projectId, draft.key)
      else st.newDraftTab(projectId)
      switchSessionRun(null)
    }
    setPanelOpen(false)
    setRenamingId(null)
    setConfirmDeleteId(null)
    setHistoryOpen(false)
  }

  const openSession = (id: string): void => {
    saveScroll()
    useAgentTabsStore.getState().openTab(projectId, id)
    switchSessionRun(id)
    setPanelOpen(false)
    setRenamingId(null)
    setConfirmDeleteId(null)
    setHistoryOpen(false)
  }

  const renameSession = (id: string, title: string): void => {
    const next = title.trim()
    if (!next) return
    void renameSessionTitle(id, projectId, next).then(() => refreshSessions(projectId))
  }

  const deleteSessionById = (id: string): void => {
    void window.api.agent.sessionDelete(id).then(() => {
      useAgentTabsStore.getState().dropSessionTabs(projectId, id)
      if (id === sessionId) {
        const st = useAgentTabsStore.getState().byProject[projectId]
        const next = st?.tabs.find((t) => t.key === st.activeKey)
        switchSessionRun(next?.sessionId ?? null)
      }
      setConfirmDeleteId(null)
      refreshSessions(projectId)
    })
  }

  const [historyOpen, setHistoryOpen] = useState(false)
  const compactPoint = findCompactPoint(turns)
  // 运行中不折叠压缩前的历史，只插分隔条；run 结束/静态加载才折叠
  const liveHistory = !!compactPoint && running

  const renderTurn = (turn: AgentTurn, idx: number) =>
    turn.role === 'user' ? (
      <div key={idx} className="flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap rounded-lg bg-amber-600/90 px-3.5 py-2 text-sm leading-6 text-zinc-950">
          {turn.text}
        </div>
      </div>
    ) : (
      <div key={idx} className="space-y-2">
        {buildRenderItems(turn).map((item) =>
          item.kind === 'text' ? (
            <Markdown key={item.key} text={item.text} className="text-sm leading-7 text-zinc-200" />
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

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-600">
        请先在左上角选择或新建项目
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5">
          {tabs.map((t) => {
            const active = t.key === activeKey
            const busy = t.sessionId ? runningIds.includes(t.sessionId) : active && running
            const title = t.sessionId
              ? (sessions.find((x) => x.id === t.sessionId)?.title ?? '会话')
              : '新会话'
            return (
              <div
                key={t.key}
                className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors ${
                  active
                    ? 'border-amber-600/60 bg-amber-600/10'
                    : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    busy ? 'animate-pulse bg-amber-500' : 'bg-zinc-600'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => activateTab(t.key, t.sessionId)}
                  className="max-w-32 cursor-pointer truncate text-xs text-zinc-200"
                >
                  {title}
                </button>
                <button
                  type="button"
                  aria-label="关闭标签"
                  title="关闭标签（任务继续后台运行）"
                  onClick={() => closeTab(t.key)}
                  className="cursor-pointer rounded-full p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
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
          <button
            type="button"
            onClick={newDraft}
            title="新会话（不影响进行中的任务）"
            className="shrink-0 cursor-pointer rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-amber-400 transition-colors hover:border-zinc-700"
          >
            ＋
          </button>
        </div>
        <div className="relative">
          <Button variant="ghost" onClick={() => setPanelOpen((v) => !v)}>
            会话管理
          </Button>
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
              <div className="absolute right-0 top-full z-30 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 shadow-xl">
                {sessions.length === 0 && (
                  <div className="px-2.5 py-2 text-xs text-zinc-600">暂无历史会话</div>
                )}
                {sessions.map((s) => {
                  const active = s.id === sessionId
                  const busy = runningIds.includes(s.id)
                  return (
                    <div
                      key={s.id}
                      className={`flex items-center gap-1 border-t border-zinc-800/60 px-1.5 py-1.5 first:border-t-0 ${
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
                            onClick={() => openSession(s.id)}
                            className="min-w-0 flex-1 cursor-pointer rounded px-1 py-0.5 text-left"
                          >
                            <div
                              className={`flex items-center gap-1.5 truncate text-xs ${
                                active ? 'font-medium text-amber-400' : 'text-zinc-200'
                              }`}
                            >
                              {busy && <Badge tone="amber">运行中</Badge>}
                              <span className="min-w-0 truncate">{s.title}</span>
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
                            title="删除（进行中的任务会被停止）"
                            onClick={() => setConfirmDeleteId(s.id)}
                            className="shrink-0 cursor-pointer rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
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
        <div className="w-[calc(50%-0.375rem)] sm:w-56">
          <div className="mb-1.5 text-xs font-medium text-zinc-400">模型</div>
          <Select value={model} onChange={(e) => setModel(e.target.value)} className="w-full">
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
        <div className="sm:pt-5">
          <Button variant="ghost" onClick={() => setInstrOpen(true)}>
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
            {compactPoint &&
              (liveHistory || historyOpen) &&
              turns.slice(0, compactPoint.index + 1).map((turn, idx) => renderTurn(turn, idx))}
            {compactPoint && liveHistory && (
              <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/60 px-3 py-2">
                <div className="text-xs text-zinc-400">
                  ⇡ 以上 {compactPoint.index + 1} 轮已压缩进摘要（任务运行中，暂不折叠）
                </div>
                <div className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">
                  {compactPoint.summary}
                </div>
              </div>
            )}
            {compactPoint && !liveHistory && (
              <button
                type="button"
                onClick={() => setHistoryOpen((v) => !v)}
                className="w-full cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-left transition-colors hover:border-zinc-700"
              >
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className={`h-3 w-3 shrink-0 text-zinc-500 transition-transform ${historyOpen ? 'rotate-180' : ''}`}
                  >
                    <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  已压缩历史（{compactPoint.index + 1} 轮对话，不回灌模型上下文）
                </div>
                <div className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">
                  {compactPoint.summary}
                </div>
              </button>
            )}
            {(compactPoint ? turns.slice(compactPoint.index + 1) : turns).map((turn, idx) =>
              renderTurn(turn, idx)
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
          <div className="flex items-start gap-3 border-t border-zinc-800 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              {error ? (
                <>
                  <ErrorHintBlock message={error} hint={errorHint} />
                  {loadFailed && (
                    <div className="mt-2">
                      <Button variant="ghost" onClick={retryLoadActive}>
                        重试
                      </Button>
                    </div>
                  )}
                </>
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
                  {!!doneInfo.autoContinues && doneInfo.autoContinues > 0 && (
                    <Badge tone="amber">自动续跑 ×{doneInfo.autoContinues}</Badge>
                  )}
                  {!!doneInfo.autoCompacts && doneInfo.autoCompacts > 0 && (
                    <Badge tone="amber">自动压缩 ×{doneInfo.autoCompacts}</Badge>
                  )}
                  {doneInfo.subagents > 0 && (
                    <Badge tone="amber">子任务 {doneInfo.subagents} 次</Badge>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </Card>

      <div className="pb-[env(safe-area-inset-bottom)]">
        {queuedNext && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-1.5 text-xs text-amber-300">
            <span className="shrink-0">已排队，完成后自动发送</span>
            <span className="min-w-0 flex-1 truncate text-amber-200/80">{queuedNext.text}</span>
            <button
              type="button"
              onClick={cancelQueue}
              className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-amber-400 transition-colors hover:bg-amber-900/40"
            >
              取消
            </button>
          </div>
        )}
        <Textarea
          ref={taRef}
          rows={3}
          value={input}
          onChange={(e) => {
            if (activeKey) useAgentTabsStore.getState().setDraft(activeKey, e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault()
              send()
              return
            }
            // 触屏兜底：回车保持换行；Shift+Enter 换行；输入法组词态回车上屏
            if (e.shiftKey || coarsePointer || e.nativeEvent.isComposing) return
            e.preventDefault()
            send()
          }}
          placeholder="描述任务，Enter 发送，例如：帮我把主角的人物卡扩写到 500 字"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="hidden text-xs text-zinc-600 sm:inline">
            Enter 发送，Shift+Enter 换行
          </span>
          <div className="flex gap-2">
            {running && (
              <Button variant="danger" onClick={stop}>
                停止
              </Button>
            )}
            <Button onClick={send} disabled={!input.trim() || !model || (!!queuedNext && running)}>
              {running ? '排队' : '发送'}
            </Button>
          </div>
        </div>
      </div>

      <OverlayCard
        open={instrOpen}
        onClose={() => setInstrOpen(false)}
        title="智能体指令"
        widthClass="max-w-2xl"
      >
        <AgentInstructionsPanel projectId={projectId} />
      </OverlayCard>
    </div>
  )
}
