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
let reconnectDelay = 1000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function emitState(state: 'open' | 'connecting' | 'closed'): void {
  window.dispatchEvent(new CustomEvent('nm-sse-state', { detail: state }))
}

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

function scheduleReconnect(): void {
  if (reconnectTimer) return
  emitState('connecting')
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    ensureSource()
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, 15_000)
}

function ensureSource(): void {
  if (source) return
  emitState('connecting')
  source = new EventSource('/api/events')
  source.onopen = () => {
    reconnectDelay = 1000
    emitState('open')
    // 断流期间的事件可能整段丢失（含尾部终态——没有后续事件到来就不会触发 gap 补拉），
    // 通知业务层对所有在途会话做一次无条件对账
    window.dispatchEvent(new CustomEvent('nm-sse-open'))
  }
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
    // 会话失效跳登录；否则按退避重建。CLOSED 状态浏览器不会自动重连，必须手动拉起
    void fetch('/api/session')
      .then((r) => r.json() as Promise<{ authenticated?: boolean }>)
      .then((s) => {
        if (!s.authenticated) redirectToLogin()
      })
      .catch(() => {
        /* 网络暂不可用时保持重连 */
      })
      .finally(() => {
        if (source && source.readyState === EventSource.CLOSED) {
          source = null
        }
        scheduleReconnect()
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
      body: JSON.stringify({ args }),
      // 响应丢失/网络假死时 30s 必然 reject，调用方才能走失败路径（否则 Promise 永久悬挂，UI 卡死）
      signal: AbortSignal.timeout(30_000)
    })
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') {
      throw new Error('请求超时（30 秒无响应），请检查电脑端连接后重试')
    }
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
