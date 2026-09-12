import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AgentSession, AgentSessionBrief } from '../shared/types'

interface StoreFile {
  sessions: AgentSession[]
}

const MAX_SESSIONS = 50

function storeFile(): string {
  return join(app.getPath('userData'), 'agent_sessions.json')
}

function readAll(): AgentSession[] {
  const file = storeFile()
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<StoreFile>
    return Array.isArray(raw.sessions) ? raw.sessions : []
  } catch {
    return []
  }
}

function writeAll(sessions: AgentSession[]): void {
  const trimmed = sessions.length > MAX_SESSIONS ? sessions.slice(0, MAX_SESSIONS) : sessions
  writeFileSync(storeFile(), JSON.stringify({ sessions: trimmed }, null, 2), 'utf-8')
}

export function listAgentSessions(projectId?: string): AgentSessionBrief[] {
  return readAll()
    .filter((s) => !projectId || s.projectId === projectId)
    .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function loadAgentSession(id: string): AgentSession | null {
  return readAll().find((s) => s.id === id) ?? null
}

export function saveAgentSession(session: AgentSession): void {
  const all = readAll().filter((s) => s.id !== session.id)
  all.unshift(session)
  writeAll(all)
}

export function deleteAgentSession(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id))
}
