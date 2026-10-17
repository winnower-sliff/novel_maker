import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { eventsToTurns, turnsToMessages } from '../shared/agentTranscript'
import type {
  AgentSession,
  AgentSessionBrief,
  AgentTranscriptEvent,
  AgentTranscriptInput,
  ChatMessage
} from '../shared/types'
import { getDb } from './db'

/**
 * 会话 transcript 事实源（SQLite agent_sessions/agent_events）。
 * 写入一律吞错（log warn）：持久化故障绝不能打断生成主链路。
 */

interface SessionRow {
  id: string
  project_id: string
  title: string
  plan_mode: number
  created_at: number
  updated_at: number
}

interface EventRow {
  session_id: string
  seq: number
  ts: number
  kind: string
  payload: string
}

function toBrief(r: SessionRow): AgentSessionBrief {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    planMode: r.plan_mode === 1,
    resumable: false
  }
}

/** 计划模式会话级开关（桌面输入框区 / 手机顶栏 toggle，落 agent_sessions.plan_mode） */
export function setPlanMode(id: string, enabled: boolean): AgentSessionBrief | null {
  const db = getDb()
  const r = getSession(id)
  if (!r) return null
  db.prepare('UPDATE agent_sessions SET plan_mode = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  return { ...r, planMode: enabled }
}

export function createSession(projectId: string, title: string): AgentSessionBrief {
  const db = getDb()
  const now = Date.now()
  const row: SessionRow = {
    id: randomUUID(),
    project_id: projectId,
    title,
    plan_mode: 0,
    created_at: now,
    updated_at: now
  }
  db.prepare(
    'INSERT INTO agent_sessions (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)'
  ).run(row.id, row.project_id, row.title, row.created_at, row.updated_at)
  return toBrief(row)
}

export function getSession(id: string): AgentSessionBrief | null {
  const r = getDb().prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as
    | SessionRow
    | undefined
  return r ? withResumable(toBrief(r)) : null
}

export function getSessionProjectId(id: string): string | null {
  const r = getDb().prepare('SELECT project_id FROM agent_sessions WHERE id = ?').get(id) as
    | { project_id: string }
    | undefined
  return r?.project_id ?? null
}

export function updateTitle(id: string, title: string): void {
  try {
    getDb().prepare('UPDATE agent_sessions SET title = ? WHERE id = ?').run(title, id)
  } catch (e) {
    console.warn('[agentTranscript] updateTitle failed:', e)
  }
}

function decodeEvent(r: EventRow): AgentTranscriptEvent {
  const payload = JSON.parse(r.payload) as Record<string, unknown>
  return { seq: r.seq, ts: r.ts, kind: r.kind, ...payload } as AgentTranscriptEvent
}

/** 追加事件并返回落库后的完整事件（含 seq/ts）；失败返回 null（调用方跳过广播，绝不杀 run） */
export function appendEvent(
  sessionId: string,
  input: AgentTranscriptInput
): AgentTranscriptEvent | null {
  try {
    const db = getDb()
    const { seq } = db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agent_events WHERE session_id = ?')
      .get(sessionId) as { seq: number }
    const ts = Date.now()
    const { kind, ...payload } = input
    db.prepare(
      'INSERT INTO agent_events (session_id, seq, ts, kind, payload) VALUES (?,?,?,?,?)'
    ).run(sessionId, seq, ts, kind, JSON.stringify(payload))
    db.prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?').run(ts, sessionId)
    return { seq, ts, kind, ...payload } as AgentTranscriptEvent
  } catch (e) {
    console.warn('[agentTranscript] appendEvent failed:', e)
    return null
  }
}

export function loadEvents(sessionId: string, afterSeq = 0): AgentTranscriptEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_events WHERE session_id = ? AND seq > ? ORDER BY seq')
    .all(sessionId, afterSeq) as unknown as EventRow[]
  return rows.map(decodeEvent)
}

export function lastSeqOf(sessionId: string): number {
  const r = getDb()
    .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM agent_events WHERE session_id = ?')
    .get(sessionId) as { s: number }
  return r.s
}

export function eventCount(sessionId: string): number {
  const r = getDb()
    .prepare('SELECT COUNT(*) AS c FROM agent_events WHERE session_id = ?')
    .get(sessionId) as { c: number }
  return r.c
}

export function listSessions(projectId?: string): AgentSessionBrief[] {
  const rows = (projectId
    ? getDb()
        .prepare(
          'SELECT * FROM agent_sessions WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC'
        )
        .all(projectId)
    : getDb()
        .prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC, created_at DESC')
        .all()) as unknown as SessionRow[]
  return rows.map((r) => withResumable(toBrief(r)))
}

/** 会话可恢复信息：最后一条 run 的收尾状态（阶段⑤中断恢复的判定源） */
export interface SessionResumeInfo {
  resumable: boolean
  /**
   * hitLimit=partial（轮次预算重置，全会上限 3 次）；
   * aborted/error/incomplete=中断（预算延续：剩余轮数 = MAX_TURNS - consumedTurns）；
   * done=无恢复点。
   */
  reason: 'done' | 'hitLimit' | 'error' | 'aborted' | 'incomplete'
  /** 最后一段任务已消耗的轮数（最后一个 user 事件之后的 assistant 事件数；done 时取 summary.turns） */
  consumedTurns: number
  /** 历史上 hitLimit 收尾的 run 数（partial 续跑上限计数） */
  hitLimitRuns: number
}

export function sessionResumeInfo(sessionId: string): SessionResumeInfo | null {
  const db = getDb()
  const last = db
    .prepare(
      'SELECT kind, payload FROM agent_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1'
    )
    .get(sessionId) as { kind: string; payload: string } | undefined
  if (!last) return null

  // 最后一段任务的轮数：最后一个 user 事件（每次 run 的起点）之后的 assistant 事件数
  const lastUser = db
    .prepare(
      "SELECT seq FROM agent_events WHERE session_id = ? AND kind = 'user' ORDER BY seq DESC LIMIT 1"
    )
    .get(sessionId) as { seq: number } | undefined
  const consumedTurns = lastUser
    ? (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM agent_events WHERE session_id = ? AND kind = 'assistant' AND seq > ?"
          )
          .get(sessionId, lastUser.seq) as { c: number }
      ).c
    : 0
  // 历史轮次总量：partial 续跑上限按全会话的 hitLimit run 数计
  let hitLimitRuns = 0
  for (const row of db
    .prepare("SELECT payload FROM agent_events WHERE session_id = ? AND kind = 'done'")
    .all(sessionId) as unknown as { payload: string }[]) {
    try {
      if ((JSON.parse(row.payload) as { hitLimit?: boolean }).hitLimit) hitLimitRuns++
    } catch {
      /* 损坏行忽略 */
    }
  }

  const info = (resumable: boolean, reason: SessionResumeInfo['reason']): SessionResumeInfo => ({
    resumable,
    reason,
    consumedTurns,
    hitLimitRuns
  })

  if (last.kind === 'done') {
    try {
      const summary = JSON.parse(last.payload) as { hitLimit?: boolean }
      return summary.hitLimit ? info(true, 'hitLimit') : info(false, 'done')
    } catch {
      return info(false, 'done')
    }
  }
  if (last.kind === 'run_error') {
    try {
      const message = (JSON.parse(last.payload) as { message?: string }).message ?? ''
      return info(true, message.includes('已停止') ? 'aborted' : 'error')
    } catch {
      return info(true, 'error')
    }
  }
  if (last.kind === 'board') {
    // 收尾序：done 先落、finishBoard 的 board 快照后落——板 done=已正常完成；
    // approved=执行中断（abort/崩溃）；awaiting/rejected=等裁决（板卡上有按钮，非中断）
    try {
      const status = (JSON.parse(last.payload) as { board?: { status?: string } }).board?.status
      return status === 'approved' ? info(true, 'incomplete') : info(false, 'done')
    } catch {
      return info(false, 'done')
    }
  }
  if (last.kind === 'plan_resolve') {
    // approve 后崩溃窗口（board 快照与执行 run 之间）；reject 后等待模型重提非中断
    try {
      return (JSON.parse(last.payload) as { action?: string }).action === 'approve'
        ? info(true, 'incomplete')
        : info(false, 'done')
    } catch {
      return info(false, 'done')
    }
  }
  // user/assistant/tool_call/tool_result/sub_event 结尾：run 无收尾事件（崩溃/重启）
  return info(true, 'incomplete')
}

function withResumable(brief: AgentSessionBrief): AgentSessionBrief {
  return { ...brief, resumable: sessionResumeInfo(brief.id)?.resumable ?? false }
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM agent_sessions WHERE id = ?').run(id)
}

/** 会话加载（兼容旧 AgentSession 形状：turns 由事件投影而来） */
export function loadSessionFull(id: string): AgentSession | null {
  const r = getDb().prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as
    | SessionRow
    | undefined
  if (!r) return null
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    planMode: r.plan_mode === 1,
    turns: eventsToTurns(loadEvents(id))
  }
}

/** 续跑前回灌：事件 → LLM messages（压缩感知，与 run 内整体替换语义一致） */
export function rebuildMessages(sessionId: string): ChatMessage[] {
  return turnsToMessages(eventsToTurns(loadEvents(sessionId)))
}

/** 旧客户端 sessionSave / JSON 迁移共用：把历史 turns 转成事件序列（ts 沿用原 turn 时间线） */
export function turnsToEvents(
  turns: AgentSession['turns']
): Array<AgentTranscriptInput & { ts?: number }> {
  const out: Array<AgentTranscriptInput & { ts?: number }> = []
  for (const t of turns) {
    if (t.role === 'board') continue // 旧客户端 turns 无看板；防御性跳过（board 事实源在 agent_boards 表）
    if (t.role === 'user') {
      out.push({ kind: 'user', text: t.text, ts: t.ts })
      continue
    }
    if (t.text.trim()) out.push({ kind: 'assistant', text: t.text, ts: t.ts })
    for (const call of t.toolCalls) {
      out.push({
        kind: 'tool_call',
        ts: t.ts,
        call: {
          id: call.id,
          name: call.name,
          input: call.input,
          state: call.state === 'running' || call.state === 'confirming' ? 'running' : call.state,
          ...(call.dangerReason !== undefined && { dangerReason: call.dangerReason })
        }
      })
      if (call.state === 'denied') {
        out.push({
          kind: 'tool_result',
          ts: t.ts,
          id: call.id,
          ok: false,
          result: call.result ?? '用户拒绝了该操作',
          denied: true
        })
      } else if (
        call.state === 'running' ||
        call.state === 'confirming' ||
        call.result === undefined
      ) {
        // 中断残留：无结果的在途卡落为中断终态
        out.push({ kind: 'tool_result', ts: t.ts, id: call.id, ok: false, result: '（已中断）' })
      } else {
        out.push({
          kind: 'tool_result',
          ts: t.ts,
          id: call.id,
          ok: call.state === 'ok',
          result: call.result
        })
      }
    }
  }
  return out
}

/** 旧客户端兼容：带 turns 的 sessionSave 落库（会话行不存在则建，事件空才导入 turns） */
export function upsertLegacySession(session: AgentSession): void {
  const db = getDb()
  const existing = db.prepare('SELECT id FROM agent_sessions WHERE id = ?').get(session.id)
  if (existing) {
    db.prepare('UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?').run(
      session.title,
      Math.max(session.updatedAt, Date.now()),
      session.id
    )
    if (eventCount(session.id) === 0 && session.turns.length > 0) {
      importTurns(session.id, session.turns)
    }
    return
  }
  const now = Date.now()
  db.prepare(
    'INSERT INTO agent_sessions (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)'
  ).run(
    session.id,
    session.projectId,
    session.title,
    session.createdAt || now,
    session.updatedAt || now
  )
  if (session.turns.length > 0) importTurns(session.id, session.turns)
}

function importTurns(sessionId: string, turns: AgentSession['turns']): boolean {
  try {
    const db = getDb()
    const events = turnsToEvents(turns)
    db.exec('BEGIN')
    let seq = 0
    const ins = db.prepare(
      'INSERT INTO agent_events (session_id, seq, ts, kind, payload) VALUES (?,?,?,?,?)'
    )
    for (const ev of events) {
      seq++
      const { kind, ts: _ts, ...payload } = ev
      ins.run(sessionId, seq, ev.ts ?? Date.now(), kind, JSON.stringify(payload))
    }
    db.prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId)
    db.exec('COMMIT')
    return true
  } catch (e) {
    try {
      getDb().exec('ROLLBACK')
    } catch {
      /* 事务本就未开 */
    }
    console.warn('[agentTranscript] importTurns failed:', e)
    return false
  }
}

/**
 * 一次性迁移：userData/agent_sessions.json → SQLite。
 * 逐会话幂等（id 已存在则跳过）；projectId 不在 projects 表的会话丢弃；
 * 成功后 JSON 改名 .bak 留档。任何失败不阻塞启动。
 */
export function migrateAgentSessionsJson(): void {
  try {
    const file = join(app.getPath('userData'), 'agent_sessions.json')
    if (!existsSync(file)) return
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<{
      sessions: AgentSession[]
    }>
    const sessions = Array.isArray(raw.sessions) ? raw.sessions : []
    if (sessions.length === 0) {
      renameToBak(file)
      return
    }
    const db = getDb()
    const projectIds = new Set(
      (db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>).map((r) => r.id)
    )
    const existsStmt = db.prepare('SELECT id FROM agent_sessions WHERE id = ?')
    const ins = db.prepare(
      'INSERT INTO agent_sessions (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)'
    )
    let imported = 0
    let failed = 0
    for (const s of sessions) {
      if (!s?.id || !s.projectId || !projectIds.has(s.projectId)) continue
      if (existsStmt.get(s.id)) {
        // 幂等：已有事件视为完整迁移；行在而事件空（上次导入中断）→ 重导 turns
        if (eventCount(s.id) > 0) continue
        if (Array.isArray(s.turns) && s.turns.length > 0) {
          if (!importTurns(s.id, s.turns)) {
            failed++
            continue
          }
          imported++
        }
        continue
      }
      ins.run(
        s.id,
        s.projectId,
        s.title ?? '',
        s.createdAt || Date.now(),
        s.updatedAt || Date.now()
      )
      if (Array.isArray(s.turns) && s.turns.length > 0 && !importTurns(s.id, s.turns)) {
        failed++
        continue
      }
      imported++
    }
    if (failed > 0) {
      // 保留 json：下次启动对「行在事件空」的会话重导 turns（自愈）
      console.warn(
        `[agentTranscript] migrate: ${failed} sessions failed to import turns, json kept for retry`
      )
      return
    }
    renameToBak(file)
    console.log(`[agentTranscript] migrated ${imported} sessions from agent_sessions.json`)
  } catch (e) {
    console.warn('[agentTranscript] migrate failed:', e)
  }
}

function renameToBak(file: string): void {
  try {
    const bak = `${file}.bak`
    if (existsSync(bak)) renameSync(bak, `${bak}.${Date.now()}.old`)
    renameSync(file, bak)
  } catch (e) {
    console.warn('[agentTranscript] rename json→bak failed:', e)
  }
}
