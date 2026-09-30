import type { ServerConfig, ServerStatus } from '../shared/types'
import { loadServerConfig } from './settings'

let current: ServerStatus = {
  enabled: false,
  running: false,
  port: 0,
  url: null,
  lanReachable: false,
  hasPassword: false,
  clients: 0,
  error: null
}

export function getServerStatus(): ServerStatus {
  return { ...current }
}

export function setServerStatus(patch: Partial<ServerStatus>): void {
  current = { ...current, ...patch }
}

export function refreshServerConfigFlags(config: ServerConfig): void {
  current = {
    ...current,
    enabled: config.enabled,
    hasPassword: !!config.passwordHash,
    port: config.port
  }
}

export function initServerStatus(): void {
  const config = loadServerConfig()
  refreshServerConfigFlags(config)
}
