import { randomUUID } from 'node:crypto'
import type { AgentBoard, AgentBoardStatus, PlanResource, PlanStep } from '../../shared/types'
import { PLAN_RESOURCES } from '../../shared/types'
import { getDb } from '../db'

/**
 * 任务看板存储（agent_boards 表，run 级事实源）：纯 DB 层。
 * 事件广播（board transcript 事件）由调用方负责（plan.ts / handlers 持有 sink 与 persist）。
 * 状态机：awaiting_approval →(approve) approved →(run 收尾) done；
 *         awaiting_approval →(reject) rejected（留史，agent 修订重提新板）。
 */

interface BoardRow {
  id: string
  session_id: string
  project_id: string
  run_id: string
  goal: string
  steps: string
  ledger: string
  status: string
  feedback: string
  created_at: number
  updated_at: number
}

function toBoard(r: BoardRow): AgentBoard {
  let steps: PlanStep[] = []
  try {
    steps = JSON.parse(r.steps) as PlanStep[]
  } catch {
    /* 损坏行按空步骤处理 */
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    projectId: r.project_id,
    runId: r.run_id,
    goal: r.goal,
    steps,
    ledger: r.ledger,
    status: r.status as AgentBoardStatus,
    feedback: r.feedback,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function getBoard(id: string): AgentBoard | null {
  const r = getDb().prepare('SELECT * FROM agent_boards WHERE id = ?').get(id) as
    | BoardRow
    | undefined
  return r ? toBoard(r) : null
}

/** 该会话最新活动看板（awaiting_approval/approved 优先，否则最近一张） */
export function activeBoard(sessionId: string): AgentBoard | null {
  const active = getDb()
    .prepare(
      "SELECT * FROM agent_boards WHERE session_id = ? AND status IN ('awaiting_approval','approved') ORDER BY created_at DESC LIMIT 1"
    )
    .all(sessionId) as unknown as BoardRow[]
  if (active.length > 0) return toBoard(active[0])
  const latest = getDb()
    .prepare('SELECT * FROM agent_boards WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(sessionId) as BoardRow | undefined
  return latest ? toBoard(latest) : null
}

export function hasAwaitingBoard(sessionId: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 AS x FROM agent_boards WHERE session_id = ? AND status = 'awaiting_approval' LIMIT 1"
    )
    .get(sessionId)
  return row !== undefined
}

/** 模型提案的步骤（服务端分配 id、校验 resource、剥离空 writeScope） */
export interface ProposedStep {
  title: string
  note?: string
  resource?: string
  ids?: string[]
}

/** 创建看板（propose_plan 落点），非法 resource 直接剔除 writeScope（宽容降级，提案不打断） */
export function createBoard(input: {
  sessionId: string
  projectId: string
  runId: string
  goal: string
  steps: ProposedStep[]
}): AgentBoard {
  const ts = Date.now()
  const steps: PlanStep[] = input.steps.map((s) => {
    const validResource =
      s.resource && (PLAN_RESOURCES as readonly string[]).includes(s.resource)
        ? (s.resource as PlanResource)
        : null
    const ids = Array.isArray(s.ids) ? s.ids.map(String).filter((x) => x) : []
    return {
      id: randomUUID(),
      title: s.title,
      note: s.note ?? '',
      status: 'pending',
      // ids 为空 = 新建授权（只按 resource 类型放行）；resource 非法才整个剔除
      ...(validResource ? { writeScope: { resource: validResource, ids } } : {})
    }
  })
  const board: AgentBoard = {
    id: randomUUID(),
    sessionId: input.sessionId,
    projectId: input.projectId,
    runId: input.runId,
    goal: input.goal,
    steps,
    ledger: '',
    status: 'awaiting_approval',
    feedback: '',
    createdAt: ts,
    updatedAt: ts
  }
  getDb()
    .prepare(
      'INSERT INTO agent_boards (id, session_id, project_id, run_id, goal, steps, ledger, status, feedback, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      board.id,
      board.sessionId,
      board.projectId,
      board.runId,
      board.goal,
      JSON.stringify(board.steps),
      board.ledger,
      board.status,
      board.feedback,
      board.createdAt,
      board.updatedAt
    )
  return board
}

function saveBoard(board: AgentBoard): AgentBoard {
  const next = { ...board, updatedAt: Date.now() }
  getDb()
    .prepare(
      'UPDATE agent_boards SET goal=?, steps=?, ledger=?, status=?, feedback=?, updated_at=? WHERE id=?'
    )
    .run(
      next.goal,
      JSON.stringify(next.steps),
      next.ledger,
      next.status,
      next.feedback,
      next.updatedAt,
      next.id
    )
  return next
}

/**
 * 用户裁决：approve（可带编辑后的步骤：删=不在 steps 里、改=title/note、增=无 id 行；writeScope 授权集
 * 服务端保留不可改，新增步骤无写授权；幻觉 id 静默忽略）/ reject（可附意见供修订重提）。仅 awaiting_approval 可裁决。
 */
export function resolveBoard(input: {
  boardId: string
  action: 'approve' | 'reject'
  feedback?: string
  steps?: Array<{ id?: string; title: string; note?: string }>
}): AgentBoard | null {
  const board = getBoard(input.boardId)
  if (board?.status !== 'awaiting_approval') return null
  if (input.action === 'reject') {
    return saveBoard({ ...board, status: 'rejected', feedback: input.feedback ?? '' })
  }
  let steps = board.steps
  if (input.steps) {
    const edits = input.steps
    steps = board.steps
      .filter((s) => edits.some((e) => e.id === s.id))
      .map((s) => {
        const patch = edits.find((e) => e.id === s.id)
        return patch ? { ...s, title: patch.title, note: patch.note ?? s.note } : s
      })
    for (const e of edits) {
      // 无 id = 用户新增步骤（无 writeScope）；有 id 但不匹配原板 = 幻觉输入，忽略
      if (!e.id || board.steps.some((s) => s.id === e.id)) continue
      steps.push({ id: randomUUID(), title: e.title, note: e.note ?? '', status: 'pending' })
    }
  }
  // approve 的 feedback=批准时的附加说明（注入执行指令）；reject 的 feedback=修订意见（供重提参考）
  return saveBoard({ ...board, steps, status: 'approved', feedback: input.feedback ?? '' })
}

/** 模型侧更新（update_board 工具）：勾销步骤 / 维护 ledger 与目标表述 */
export function updateBoard(
  boardId: string,
  patch: {
    stepUpdates?: Array<{ id: string; status?: PlanStep['status']; note?: string }>
    ledger?: string
    goal?: string
  }
): AgentBoard | null {
  const board = getBoard(boardId)
  if (!board) return null
  if (board.status !== 'approved' && board.status !== 'awaiting_approval') return null
  let steps = board.steps
  if (patch.stepUpdates) {
    const byId = new Map(patch.stepUpdates.map((u) => [u.id, u]))
    steps = board.steps.map((s) => {
      const u = byId.get(s.id)
      return u ? { ...s, status: u.status ?? s.status, note: u.note ?? s.note } : s
    })
  }
  return saveBoard({
    ...board,
    steps,
    ledger: patch.ledger ?? board.ledger,
    goal: patch.goal ?? board.goal
  })
}

/** 执行 run 收尾：正常完成时看板置 done（异常/中止保持 approved，恢复语义见阶段⑤） */
export function finishBoard(boardId: string): AgentBoard | null {
  const board = getBoard(boardId)
  if (board?.status !== 'approved') return null
  return saveBoard({ ...board, status: 'done' })
}

/**
 * 批准回滚（补偿）：执行 run 启动失败时把板从 approved 退回 awaiting_approval，
 * 清掉批准说明（避免污染下次裁决），用户可重试批准。仅 approved 可回。
 */
export function revertApproval(boardId: string): AgentBoard | null {
  const board = getBoard(boardId)
  if (board?.status !== 'approved') return null
  return saveBoard({ ...board, status: 'awaiting_approval', feedback: '' })
}
