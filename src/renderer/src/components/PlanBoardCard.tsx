import type { AgentBoard, PlanResolve, PlanStep } from '@shared/types'
import { useState } from 'react'
import { Badge, Button } from './ui'

const STATUS_LABEL: Record<AgentBoard['status'], string> = {
  awaiting_approval: '待批准',
  approved: '执行中',
  rejected: '已拒绝',
  done: '已完成',
  cancelled: '已取消'
}

const STEP_STATUS_CLASS: Record<PlanStep['status'], string> = {
  done: 'bg-emerald-600/20 text-emerald-400',
  in_progress: 'bg-amber-600/20 text-amber-400',
  skipped: 'bg-zinc-700/60 text-zinc-500',
  pending: 'bg-zinc-800 text-zinc-500'
}

const STEP_STATUS_LABEL: Record<PlanStep['status'], string> = {
  done: '完成',
  in_progress: '进行中',
  skipped: '跳过',
  pending: '待办'
}

const RESOURCE_LABEL: Record<string, string> = {
  project: '项目',
  character: '人物卡',
  worldbuild: '世界观',
  outline: '大纲',
  chapter: '章节正文',
  foreshadow: '伏笔',
  summary: '摘要',
  instruction: '指令'
}

function scopeText(s: PlanStep): string | null {
  if (!s.writeScope) return null
  const label = RESOURCE_LABEL[s.writeScope.resource] ?? s.writeScope.resource
  return s.writeScope.ids.length > 0 ? `${label}（${s.writeScope.ids.join('、')}）` : label
}

type DraftStep = {
  id?: string
  title: string
  note: string
  status: PlanStep['status']
  scope: string | null
}

/**
 * 计划看板卡（流内原地更新）：awaiting_approval 时提供批准/拒绝/编辑；
 * 编辑仅改本地草稿，批准时随 planResolve 一并提交（writeScope 授权集只读展示）。
 */
export function PlanBoardCard({
  board,
  resolve: resolveInfo,
  sessionId
}: {
  board: AgentBoard
  resolve?: PlanResolve
  sessionId: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<DraftStep[]>([])
  const [approveOpen, setApproveOpen] = useState(false)
  const [approveNote, setApproveNote] = useState('')
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectNote, setRejectNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const awaiting = board.status === 'awaiting_approval'
  const steps = board.steps
  const doneCount = steps.filter((s) => s.status === 'done').length
  // 编辑后的草稿在批准前作为查看态展示源（刷新丢弃；批准时随 planResolve 提交）
  const showSteps: DraftStep[] =
    awaiting && draft.length > 0
      ? draft
      : steps.map((s) => ({
          id: s.id,
          title: s.title,
          note: s.note ?? '',
          status: s.status,
          scope: scopeText(s)
        }))

  const startEdit = (): void => {
    setDraft(
      steps.map((s) => ({
        id: s.id,
        title: s.title,
        note: s.note ?? '',
        status: s.status,
        scope: scopeText(s)
      }))
    )
    setEditing(true)
    setApproveOpen(false)
    setRejectOpen(false)
  }

  const mutateDraft = (i: number, patch: Partial<DraftStep>): void => {
    setDraft((d) => d.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  }

  const resolve = (action: 'approve' | 'reject', feedback: string, edited?: DraftStep[]): void => {
    setBusy(true)
    setErr('')
    window.api.agent
      .planResolve({
        sessionId,
        boardId: board.id,
        action,
        feedback: feedback.trim() || undefined,
        // 编辑后批准：一并提交（删=不在清单、改=title/note、新增=无 id 行）
        steps:
          action === 'approve' && edited
            ? edited.map(({ title, note, id }) => ({ title, note: note || undefined, id }))
            : undefined
      })
      .catch((e: unknown) => {
        setErr((e as Error).message || '操作失败')
      })
      .finally(() => setBusy(false))
  }

  return (
    <div
      data-board-id={board.id}
      className="rounded-lg border border-amber-600/40 bg-amber-600/5 px-3 py-2.5 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2 font-medium text-amber-500">
        <span>计划看板</span>
        <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-xs text-zinc-400">
          {STATUS_LABEL[board.status]}
        </span>
        {steps.length > 0 && board.status === 'approved' && (
          <span className="text-xs text-zinc-500">
            进度 {doneCount}/{steps.length}
          </span>
        )}
        {resolveInfo ? (
          <span
            className={`rounded px-1.5 py-0.5 text-xs ${
              resolveInfo.action === 'approve'
                ? 'bg-emerald-600/20 text-emerald-400'
                : 'bg-red-600/20 text-red-400'
            }`}
          >
            {resolveInfo.action === 'approve' ? '用户已批准' : '用户已拒绝'}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 text-zinc-300">{board.goal}</div>

      {editing ? (
        <div className="mt-2 space-y-1.5">
          {draft.map((s, i) => (
            <div key={s.id ?? `new-${i}`} className="flex items-start gap-1.5">
              <input
                value={s.title}
                onChange={(e) => mutateDraft(i, { title: e.target.value })}
                placeholder="步骤描述"
                className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-amber-600/60"
              />
              <button
                type="button"
                title={s.id ? '删除该步骤（其写授权一并作废）' : '删除'}
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                className="shrink-0 cursor-pointer rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
              >
                删
              </button>
              {s.id ? (
                <span className="shrink-0 self-center text-[10px] text-zinc-600">有授权</span>
              ) : (
                <span className="shrink-0 self-center text-[10px] text-zinc-600">无授权</span>
              )}
            </div>
          ))}
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={() =>
                setDraft((d) => [...d, { title: '', note: '', status: 'pending', scope: null }])
              }
              className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-amber-400 hover:bg-zinc-800"
            >
              ＋ 添加步骤
            </button>
            <span className="text-[10px] text-zinc-600">
              新增步骤不含写授权，执行时超范围会被拦截
            </span>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button
              onClick={() => setEditing(false)}
              disabled={draft.some((s) => !s.title.trim())}
              title={draft.some((s) => !s.title.trim()) ? '存在空步骤' : undefined}
            >
              应用修改
            </Button>
          </div>
        </div>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {showSteps.map((s, i) => (
            <li key={s.id ?? `new-${i}`} className="flex items-start gap-2 text-zinc-400">
              <span
                className={`mt-0.5 shrink-0 rounded px-1 text-xs ${STEP_STATUS_CLASS[s.status]}`}
              >
                {STEP_STATUS_LABEL[s.status]}
              </span>
              <span className="min-w-0 flex-1">
                {s.title}
                {s.scope ? (
                  <span className="ml-1.5 rounded bg-zinc-800/60 px-1 py-0.5 text-[10px] text-zinc-500">
                    授权：{s.scope}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {board.feedback && resolveInfo?.action === 'reject' ? (
        <div className="mt-1.5 whitespace-pre-wrap rounded bg-red-950/40 px-2 py-1 text-xs text-red-300">
          用户意见：{board.feedback}
        </div>
      ) : null}
      {board.feedback && resolveInfo?.action === 'approve' ? (
        <div className="mt-1.5 whitespace-pre-wrap rounded bg-emerald-950/30 px-2 py-1 text-xs text-emerald-300/80">
          批准说明：{board.feedback}
        </div>
      ) : null}

      {awaiting && !editing && !resolveInfo && (
        <div className="mt-2 border-t border-amber-700/20 pt-2">
          {approveOpen ? (
            <div className="space-y-1.5">
              <textarea
                value={approveNote}
                onChange={(e) => setApproveNote(e.target.value)}
                rows={2}
                placeholder="附加说明（可选）：批准时注入执行指令的补充要求"
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-amber-600/60"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setApproveOpen(false)}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  onClick={() =>
                    resolve('approve', approveNote, draft.length > 0 ? draft : undefined)
                  }
                  disabled={busy || draft.some((s) => !s.title.trim())}
                >
                  {busy ? '提交中…' : '确认批准并执行'}
                </Button>
              </div>
            </div>
          ) : rejectOpen ? (
            <div className="space-y-1.5">
              <textarea
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                rows={2}
                placeholder="拒绝意见（建议填写）：供智能体修订计划后重新提案"
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-amber-600/60"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setRejectOpen(false)}>
                  取消
                </Button>
                <Button
                  variant="danger"
                  onClick={() => resolve('reject', rejectNote)}
                  disabled={busy}
                >
                  {busy ? '提交中…' : '确认拒绝'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => setApproveOpen(true)} disabled={busy}>
                批准
              </Button>
              <Button variant="danger" onClick={() => setRejectOpen(true)} disabled={busy}>
                拒绝
              </Button>
              <Button variant="ghost" onClick={startEdit}>
                编辑步骤
              </Button>
              <span className="text-[10px] text-zinc-600">
                批准后智能体在授权范围内免确认执行；删除类操作仍会弹窗
              </span>
            </div>
          )}
        </div>
      )}
      {err ? <div className="mt-1.5 text-xs text-red-400">{err}</div> : null}
      {draft.length > 0 && !editing && awaiting && (
        <div className="mt-1.5">
          <Badge tone="amber">已编辑（批准时生效，含 {draft.length} 步）</Badge>
        </div>
      )}
    </div>
  )
}
