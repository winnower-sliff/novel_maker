import { type ApiTransport, buildApi } from '@shared/contract'

/**
 * 浏览器环境下的 window.api 适配器：把契约通道映射为
 * 同源 HTTP RPC（POST /api/invoke/:channel）+ SSE（GET /api/events）。
 * Electron 下 preload 已注入 window.api，本模块直接跳过。
 */

declare global {
  interface Window {
    __NM_WEB__?: boolean
  }
}

type EventListener = (...args: never[]) => void

const listeners = new Map<string, Set<EventListener>>()
let source: EventSource | null = null
let redirecting = false

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

function redirectToLogin(): void {
  if (redirecting) return
  redirecting = true
  window.location.href = '/login'
}

function ensureSource(): void {
  if (source) return
  source = new EventSource('/api/events')
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
    void fetch('/api/session')
      .then((r) => r.json() as Promise<{ authenticated?: boolean }>)
      .then((s) => {
        if (!s.authenticated) redirectToLogin()
      })
      .catch(() => {
        /* 网络暂不可用时保持重连 */
      })
  }
}

async function rpc(channel: string, args: unknown[]): Promise<unknown> {
  ensureSource()
  let res: Response
  try {
    res = await fetch(`/api/invoke/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args })
    })
  } catch (err) {
    throw new Error(`无法连接服务器: ${(err as Error).message}`)
  }
  if (res.status === 401) {
    redirectToLogin()
    throw new Error('登录已失效，请重新登录')
  }
  const data = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null
  if (!res.ok || data?.error) throw new Error(data?.error ?? `HTTP ${res.status}`)
  return data?.result
}

function parseFilename(disposition: string): string | null {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (star) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      return star[1]
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition)
  return plain ? plain[1] : null
}

async function exportViaHttp(opts: unknown): Promise<{ path: string; words: number }> {
  ensureSource()
  let res: Response
  try {
    res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts)
    })
  } catch (err) {
    throw new Error(`无法连接服务器: ${(err as Error).message}`)
  }
  if (res.status === 401) {
    redirectToLogin()
    throw new Error('登录已失效，请重新登录')
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(data?.error ?? `HTTP ${res.status}`)
  }
  const filename = parseFilename(res.headers.get('content-disposition') ?? '') ?? 'novel.txt'
  const words = Number(res.headers.get('x-words') ?? 0) || 0
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return { path: filename, words }
}

function installWebBridge(): void {
  if (window.api) return
  window.__NM_WEB__ = true
  ensureSource()

  const transport: ApiTransport = {
    invoke: (channel, args) => rpc(channel, args),
    subscribe: (channel, cb) => on(channel, cb)
  }
  const api = buildApi(transport)

  // 桌面专属通道在浏览器端的降级/替代实现
  api.server.config = () => Promise.reject(new Error('服务器配置仅能在桌面端修改'))
  api.exporter.run = (opts) => exportViaHttp(opts)

  window.api = api
}

installWebBridge()
