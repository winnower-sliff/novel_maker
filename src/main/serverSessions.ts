import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, ensureDataDir } from './paths.js'

/**
 * 访问会话持久化：token 90 天有效（DECISIONS：token 90 天可吊销；改密码全作废）。
 * 手机端依赖 token 跨服务器重启保持免密登录。
 */

interface SessionEntry {
  token: string
  createdAt: number
  /** 设备备注（手机型号等，设置页吊销用） */
  label?: string
}

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000

let sessions: SessionEntry[] = []

function file(): string {
  return join(dataDir(), 'sessions.json')
}

function prune(now = Date.now()): void {
  const before = sessions.length
  sessions = sessions.filter((s) => now - s.createdAt < SESSION_TTL_MS)
  if (sessions.length !== before) persist()
}

try {
  const raw = readFileSync(file(), 'utf-8')
  const parsed = JSON.parse(raw) as { sessions?: SessionEntry[] }
  sessions = Array.isArray(parsed.sessions)
    ? parsed.sessions.filter((s) => typeof s?.token === 'string')
    : []
  prune()
} catch {
  sessions = []
}

function persist(): void {
  try {
    ensureDataDir()
    writeFileSync(file(), JSON.stringify({ sessions }, null, 2))
  } catch {
    /* 写盘失败不阻断主流程 */
  }
}

export function hasSession(token: string): boolean {
  prune()
  return sessions.some((s) => s.token === token)
}

export function addSession(token: string, label?: string): void {
  if (!sessions.some((s) => s.token === token)) {
    sessions.push({ token, createdAt: Date.now(), label })
    persist()
  }
}

export function removeSession(token: string): void {
  const idx = sessions.findIndex((s) => s.token === token)
  if (idx >= 0) {
    sessions.splice(idx, 1)
    persist()
  }
}

export function clearSessions(): void {
  sessions = []
  persist()
}

export function listSessions(): Array<{
  token: string
  masked: string
  createdAt: number
  label?: string
}> {
  prune()
  return sessions.map((s) => ({
    token: s.token,
    masked: `${s.token.slice(0, 6)}***${s.token.slice(-4)}`,
    createdAt: s.createdAt,
    label: s.label
  }))
}
