import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 访问会话持久化：token 永久有效（直到改密码全作废）。
 * 手机端依赖 token 跨服务器重启保持免密登录。
 */

const SESSIONS_FILE = 'sessions.json'

let tokens: string[] = []

function file(): string {
  return join(app.getPath('userData'), SESSIONS_FILE)
}

try {
  const raw = readFileSync(file(), 'utf-8')
  const parsed = JSON.parse(raw) as { tokens?: string[] }
  tokens = Array.isArray(parsed.tokens) ? parsed.tokens.filter((t) => typeof t === 'string') : []
} catch {
  tokens = []
}

function persist(): void {
  try {
    writeFileSync(file(), JSON.stringify({ tokens }))
  } catch {
    /* 写盘失败不阻断主流程 */
  }
}

export function hasSession(token: string): boolean {
  return tokens.includes(token)
}

export function addSession(token: string): void {
  if (!tokens.includes(token)) tokens.push(token)
  persist()
}

export function removeSession(token: string): void {
  const idx = tokens.indexOf(token)
  if (idx >= 0) {
    tokens.splice(idx, 1)
    persist()
  }
}

export function clearSessions(): void {
  tokens = []
  persist()
}
