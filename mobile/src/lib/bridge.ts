import { buildApi, type ApiTransport } from '@shared/contract'
import type { Api } from '@shared/contract'
import { loadConn, useConnStore } from './conn'

declare global {
  interface Window {
    api: Api
  }
}

/**
 * 移动端远端 transport：window.api 的全部 invoke 走
 * POST {baseUrl}/api/invoke/:channel（x-nm-token 鉴权），
 * 事件走 EventSource {baseUrl}/api/events?token=…（SSE 无法带自定义 header）。
 */

type EventListener = (...args: never[]) => void

const listeners = new Map<string, Set<EventListener>>()
let source: EventSource | null = null

function on(channel: string, cb: EventListener): () => void {
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
  }
  set.add(cb)
  return () => {
    set?.delete(cb)
  }
}

function onUnauthorized(): void {
  useConnStore.getState().setConn(null)
  window.location.reload()
}

function ensureSource(): void {
  if (source) return
  const conn = loadConn()
  if (!conn) return
  source = new EventSource(
    `${conn.baseUrl}/api/events?token=${encodeURIComponent(conn.token)}`
  )
  source.onmessage = (ev: MessageEvent<string>) => {
    try {
      const data = JSON.parse(ev.data) as {
        channel: string
        requestId: string
        args: unknown[]
      }
      const set = listeners.get(data.channel)
      if (!set) return
      for (const cb of set) (cb as (...a: unknown[]) => void)(data.requestId, ...data.args)
    } catch {
      /* 忽略无法解析的事件 */
    }
  }
  source.onerror = () => {
    /* EventSource 自动重连；token 失效由 invoke 401 统一处理 */
  }
}

async function rpc(channel: string, args: unknown[]): Promise<unknown> {
  ensureSource()
  const conn = loadConn()
  if (!conn) throw new Error('尚未连接服务器')
  let res: Response
  try {
    res = await fetch(`${conn.baseUrl}/api/invoke/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nm-token': conn.token },
      body: JSON.stringify({ args })
    })
  } catch (err) {
    throw new Error(`无法连接服务器: ${(err as Error).message}`)
  }
  if (res.status === 401) {
    onUnauthorized()
    throw new Error('登录已失效，请重新连接')
  }
  const data = (await res.json().catch(() => null)) as {
    result?: unknown
    error?: string
  } | null
  if (!res.ok || data?.error) throw new Error(data?.error ?? `HTTP ${res.status}`)
  return data?.result
}

export function installBridge(): void {
  if (window.api) return
  if (!loadConn()) return
  ensureSource()
  const transport: ApiTransport = {
    invoke: (channel, args) => rpc(channel, args),
    subscribe: (channel, cb) => on(channel, cb)
  }
  window.api = buildApi(transport)
}

/** 供「APP 更新」检查使用：带 token 拉取电脑端 APK 版本清单 */
export async function fetchMobileVersion(conn: {
  baseUrl: string
  token: string
}): Promise<{
  version: string | null
  buildAt: string | null
  apk?: { version: string; path: string; size: number }
}> {
  const res = await fetch(`${conn.baseUrl}/api/mobile/version`, {
    headers: { 'x-nm-token': conn.token }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as {
    version: string | null
    buildAt: string | null
    apk?: { version: string; path: string; size: number }
  }
}
