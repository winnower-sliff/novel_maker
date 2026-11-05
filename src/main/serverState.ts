import type { ServerStatus } from '../shared/types.js'
import { getPort, hasPassword } from './config.js'

const startedAt = Date.now()

let current: ServerStatus = {
  running: false,
  port: 0,
  url: null,
  lanReachable: false,
  hasPassword: false,
  clients: 0,
  version: '',
  uptimeS: 0,
  error: null
}

export function getServerStatus(): ServerStatus {
  return { ...current, uptimeS: Math.floor((Date.now() - startedAt) / 1000) }
}

export function setServerStatus(patch: Partial<ServerStatus>): void {
  current = { ...current, ...patch }
}

export function refreshServerConfigFlags(): void {
  current = { ...current, port: getPort(), hasPassword: hasPassword() }
}
