import { buildApi, type Api, type ApiTransport } from '@shared/contract'
import { loadConn } from './conn'

declare global {
  interface Window {
    api: Api
  }
}

/**
 * 移动端远端 transport：invoke 走 POST {baseUrl}/api/invoke/:channel，
 * 事件走 EventSource {baseUrl}/api/events。v2 无鉴权（Tailscale 即信任边界）。
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

function ensureSource(): void {
  if (source) return
  const conn = loadConn()
  if (!conn) return
  source = new EventSource(`${conn.baseUrl}/api/events`)
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
    /* EventSource 自动重连 */
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(30_000)
    })
  } catch (err) {
    const name = (err as Error).name
    if (name === 'TimeoutError' || name === 'AbortError')
      throw new Error('请求超时，请检查与电脑的连接后重试')
    throw new Error(`无法连接服务器: ${(err as Error).message}`)
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
