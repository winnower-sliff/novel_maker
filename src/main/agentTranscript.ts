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
  return { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }
}

export function createSession(projectId: string, title: string): AgentSessionBrief {
  const db = getDb()
  const now = Date.now()
  const row: SessionRow = {
    id: randomUUID(),
    project_id: projectId,
    title,
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
  return r ? toBrief(r) : null
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

export function appendEvent(sessionId: string, input: AgentTranscriptInput): void {
  try {
    const db = getDb()
    const { seq } = db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agent_events WHERE session_id = ?')
      .get(sessionId) as { seq: number }
    const { kind, ...payload } = input
    db.prepare(
      'INSERT INTO agent_events (session_id, seq, ts, kind, payload) VALUES (?,?,?,?,?)'
    ).run(sessionId, seq, Date.now(), kind, JSON.stringify(payload))
    db.prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId)
  } catch (e) {
    console.warn('[agentTranscript] appendEvent failed:', e)
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
  return rows.map(toBrief)
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
    turns: eventsToTurns(loadEvents(id))
  }
}

/** 续跑前回灌：事件 → LLM messages（压缩感知，与 run 内整体替换语义一致） */
export function rebuildMessages(sessionId: string): ChatMessage[] {
  return turnsToMessages(eventsToTurns(loadEvents(sessionId)))
}

/** 旧客户端 sessionSave / JSON 迁移共用：把历史 turns 转成事件序列 */
export function turnsToEvents(turns: AgentSession['turns']): AgentTranscriptInput[] {
  const out: AgentTranscriptInput[] = []
  for (const t of turns) {
    if (t.role === 'user') {
      out.push({ kind: 'user', text: t.text })
      continue
    }
    if (t.text.trim()) out.push({ kind: 'assistant', text: t.text })
    for (const call of t.toolCalls) {
      out.push({
        kind: 'tool_call',
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
        out.push({ kind: 'tool_result', id: call.id, ok: false, result: '（已中断）' })
      } else {
        out.push({ kind: 'tool_result', id: call.id, ok: call.state === 'ok', result: call.result })
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

function importTurns(sessionId: string, turns: AgentSession['turns']): void {
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
      const { kind, ...payload } = ev
      ins.run(sessionId, seq, Date.now(), kind, JSON.stringify(payload))
    }
    db.prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId)
    db.exec('COMMIT')
  } catch (e) {
    try {
      getDb().exec('ROLLBACK')
    } catch {
      /* 事务本就未开 */
    }
    console.warn('[agentTranscript] importTurns failed:', e)
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
    for (const s of sessions) {
      if (!s?.id || !s.projectId || !projectIds.has(s.projectId)) continue
      if (existsStmt.get(s.id)) continue
      ins.run(
        s.id,
        s.projectId,
        s.title ?? '',
        s.createdAt || Date.now(),
        s.updatedAt || Date.now()
      )
      if (Array.isArray(s.turns) && s.turns.length > 0) importTurns(s.id, s.turns)
      imported++
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
