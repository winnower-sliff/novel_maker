import { randomUUID } from 'node:crypto'
import type { AgentQueueItem, AgentTranscriptInput } from '../../shared/types'
import { getSession } from '../agentTranscript'
import { getDb } from '../db'
import type { EventSink } from '../eventSink'

/**
 * 智能体持久化队列（agent_queue 表）：
 * - task：排队任务，同会话按 position 顺序，run 正常收尾后由主进程消费续发；
 * - inject：运行中插入指令，run 循环安全点（工具返回后、下一轮模型调用前）注入。
 * 队列失败冻结：run error/abort 收尾不触发消费，剩余项保留待用户手动继续/跳过。
 */

interface QueueRow {
  id: string
  session_id: string
  project_id: string
  kind: string
  text: string
  model: string
  provider: string
  position: number
  created_at: number
}

function toItem(r: QueueRow): AgentQueueItem {
  return {
    id: r.id,
    sessionId: r.session_id,
    projectId: r.project_id,
    kind: r.kind === 'inject' ? 'inject' : 'task',
    text: r.text,
    model: r.model,
    provider: r.provider,
    position: r.position,
    createdAt: r.created_at
  }
}

const SELECT_BY_PROJECT = 'SELECT * FROM agent_queue WHERE project_id = ? ORDER BY created_at'
// inject 组在前按时间序、task 组在后按 position（CASE 只换排序键值，需先分组再组内排序）
const SELECT_BY_SESSION =
  "SELECT * FROM agent_queue WHERE session_id = ? ORDER BY CASE kind WHEN 'inject' THEN 0 ELSE 1 END, CASE kind WHEN 'inject' THEN created_at ELSE position END"

/** 每会话队列总上限（task+inject 合计），超出拒绝入队 */
export const QUEUE_MAX_PER_SESSION = 20

export function listQueue(projectId: string): AgentQueueItem[] {
  return (getDb().prepare(SELECT_BY_PROJECT).all(projectId) as unknown as QueueRow[]).map(toItem)
}

function listSessionQueue(sessionId: string): AgentQueueItem[] {
  return (getDb().prepare(SELECT_BY_SESSION).all(sessionId) as unknown as QueueRow[]).map(toItem)
}

/** 广播该项目全量队列（≤20 条，直接推全量让三端镜像同一事实源） */
export function broadcastQueue(sink: EventSink, projectId: string): void {
  if (!sink.isClosed()) sink.send('agent:queue', projectId, listQueue(projectId))
}

export function addQueueItem(
  sink: EventSink,
  input: {
    sessionId: string
    projectId: string
    kind: 'task' | 'inject'
    text: string
    model?: string
    provider?: string
  }
): AgentQueueItem {
  if (!getSession(input.sessionId)) throw new Error('会话不存在或已删除')
  const db = getDb()
  const countRow = db
    .prepare('SELECT COUNT(*) AS c FROM agent_queue WHERE session_id = ?')
    .get(input.sessionId) as { c: number }
  if (countRow.c >= QUEUE_MAX_PER_SESSION)
    throw new Error(`队列已满（每会话上限 ${QUEUE_MAX_PER_SESSION} 条）`)
  const kind = input.kind === 'inject' ? 'inject' : 'task'
  const posRow = db
    .prepare(
      "SELECT COALESCE(MAX(position), 0) + 1 AS p FROM agent_queue WHERE session_id = ? AND kind = 'task'"
    )
    .get(input.sessionId) as { p: number }
  const row: QueueRow = {
    id: randomUUID(),
    session_id: input.sessionId,
    project_id: input.projectId,
    kind,
    text: input.text,
    model: input.model ?? '',
    provider: input.provider ?? '',
    position: posRow.p,
    created_at: Date.now()
  }
  db.prepare(
    'INSERT INTO agent_queue (id, session_id, project_id, kind, text, model, provider, position, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    row.id,
    row.session_id,
    row.project_id,
    row.kind,
    row.text,
    row.model,
    row.provider,
    row.position,
    row.created_at
  )
  broadcastQueue(sink, input.projectId)
  return toItem(row)
}

export function removeQueueItem(sink: EventSink, id: string): void {
  const row = getDb().prepare('SELECT * FROM agent_queue WHERE id = ?').get(id) as
    | QueueRow
    | undefined
  if (!row) return
  getDb().prepare('DELETE FROM agent_queue WHERE id = ?').run(id)
  broadcastQueue(sink, row.project_id)
}

export function moveQueueItem(sink: EventSink, id: string, dir: 'up' | 'down'): void {
  const db = getDb()
  const row = db.prepare('SELECT * FROM agent_queue WHERE id = ?').get(id) as QueueRow | undefined
  if (row?.kind !== 'task') return
  const rows = db
    .prepare(
      "SELECT id, position FROM agent_queue WHERE session_id = ? AND kind = 'task' ORDER BY position"
    )
    .all(row.session_id) as Array<{ id: string; position: number }>
  const idx = rows.findIndex((r) => r.id === id)
  const swapWith = dir === 'up' ? idx - 1 : idx + 1
  if (idx < 0 || swapWith < 0 || swapWith >= rows.length) return
  const update = db.prepare('UPDATE agent_queue SET position = ? WHERE id = ?')
  update.run(rows[swapWith].position, row.id)
  update.run(row.position, rows[swapWith].id)
  broadcastQueue(sink, row.project_id)
}

/**
 * 取该会话下一条待消费项：插入指令优先（按时间序），否则第一条排队任务（按 position）。
 */
function nextConsumable(sessionId: string): AgentQueueItem | null {
  const items = listSessionQueue(sessionId)
  return items.find((i) => i.kind === 'inject') ?? items.find((i) => i.kind === 'task') ?? null
}

/**
 * run 收尾消费（主进程驱动，三端镜像不双发）：删行→广播→启动下一条 run。
 * launch 由 stream.ts 注入（避免循环依赖），启动失败时把指令插回队首保留。
 */
export function consumeNext(
  sink: EventSink,
  sessionId: string,
  launch: (next: AgentQueueItem) => { requestId: string; sessionId: string }
): { requestId: string; sessionId: string } | null {
  const next = nextConsumable(sessionId)
  if (!next) return null
  getDb().prepare('DELETE FROM agent_queue WHERE id = ?').run(next.id)
  broadcastQueue(sink, next.projectId)
  try {
    return launch(next)
  } catch (err) {
    console.warn('[agentQueue] consume launch failed, re-queued:', (err as Error)?.message)
    getDb()
      .prepare(
        'INSERT INTO agent_queue (id, session_id, project_id, kind, text, model, provider, position, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(
        next.id,
        next.sessionId,
        next.projectId,
        next.kind,
        next.text,
        next.model,
        next.provider,
        next.position,
        next.createdAt
      )
    broadcastQueue(sink, next.projectId)
    return null
  }
}

/**
 * run 循环安全点注入：把该会话全部 pending 插入指令落为 user 事件、删行、广播。
 * 返回注入文本供 run.ts 追加进 messages（作为正常 user 消息进入后续模型调用与历史回灌）。
 */
export function drainInjections(
  sink: EventSink,
  sessionId: string,
  persist: (ev: AgentTranscriptInput) => void
): string[] {
  const items = listSessionQueue(sessionId).filter((i) => i.kind === 'inject')
  if (items.length === 0) return []
  const db = getDb()
  const del = db.prepare('DELETE FROM agent_queue WHERE id = ?')
  const texts: string[] = []
  for (const item of items) {
    del.run(item.id)
    persist({ kind: 'user', text: item.text })
    texts.push(item.text)
  }
  if (items[0]) broadcastQueue(sink, items[0].projectId)
  return texts
}
