import type { Api } from '../../preload'

/**
 * 浏览器环境下的 window.api 适配器：把 preload 暴露的 IPC 接口映射为
 * 同源 HTTP RPC（POST /api/invoke/:channel）+ SSE（GET /api/events）。
 * Electron 下 preload 已注入 window.api，本模块直接跳过。
 */

declare global {
  interface Window {
    __NM_WEB__?: boolean
  }
}

type EventListener = (requestId: string, ...args: any[]) => void

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
      for (const cb of set) cb(data.requestId, ...data.args)
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

async function rpc(channel: string, args: unknown[]): Promise<any> {
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

function installWebBridge(): void {
  if (window.api) return
  window.__NM_WEB__ = true
  ensureSource()

  const api: Api = {
    settings: {
      get: () => rpc('settings:get', []),
      save: (patch) => rpc('settings:save', [patch])
    },
    server: {
      status: () => rpc('server:status', []),
      config: () => Promise.reject(new Error('服务器配置仅能在桌面端修改'))
    },
    models: {
      probe: (opts) => rpc('models:probe', [opts])
    },
    llm: {
      chat: (params) => rpc('llm:chat', [params]),
      abort: (requestId) => rpc('llm:abort', [requestId]),
      onDelta: (cb) => on('llm:delta', cb),
      onDone: (cb) => on('llm:done', cb),
      onError: (cb) => on('llm:error', cb),
      onNotice: (cb) => on('llm:notice', cb)
    },
    usage: {
      list: (limit) => rpc('usage:list', [limit]),
      stats: () => rpc('usage:stats', [])
    },
    novel: {
      projects: () => rpc('novel:projects', []),
      projectCreate: (input) => rpc('novel:projectCreate', [input]),
      projectUpdate: (id, input) => rpc('novel:projectUpdate', [id, input]),
      projectDelete: (id) => rpc('novel:projectDelete', [id]),
      characters: (projectId) => rpc('novel:characters', [projectId]),
      characterSave: (input) => rpc('novel:characterSave', [input]),
      characterDelete: (id) => rpc('novel:characterDelete', [id]),
      worldbuild: (projectId) => rpc('novel:worldbuild', [projectId]),
      worldbuildSave: (input) => rpc('novel:worldbuildSave', [input]),
      worldbuildDelete: (id) => rpc('novel:worldbuildDelete', [id]),
      worldbuildDeleteBatch: (projectId, ids) =>
        rpc('novel:worldbuildDeleteBatch', [projectId, ids]),
      worldbuildCommitChunk: (projectId, rawText, categories, opts) =>
        rpc('novel:worldbuildCommitChunk', [projectId, rawText, categories, opts]),
      worldbuildRelink: (projectId, entryIds) =>
        rpc('novel:worldbuildRelink', [projectId, entryIds]),
      worldbuildRetrieve: (p) => rpc('novel:worldbuildRetrieve', [p]),
      worldbuildSaveBatch: (projectId, entries) =>
        rpc('novel:worldbuildSaveBatch', [projectId, entries]),
      worldbuildTypes: (projectId) => rpc('novel:worldbuildTypes', [projectId]),
      worldbuildTypeCreate: (projectId, name) =>
        rpc('novel:worldbuildTypeCreate', [projectId, name]),
      worldbuildTypeDelete: (projectId, name) =>
        rpc('novel:worldbuildTypeDelete', [projectId, name]),
      worldbuildTypeReorder: (projectId, name, pos) =>
        rpc('novel:worldbuildTypeReorder', [projectId, name, pos]),
      outlines: (projectId) => rpc('novel:outlines', [projectId]),
      outlineSave: (input) => rpc('novel:outlineSave', [input]),
      outlineDelete: (id) => rpc('novel:outlineDelete', [id]),
      chapterBriefs: (projectId) => rpc('novel:chapterBriefs', [projectId]),
      chapter: (outlineId) => rpc('novel:chapter', [outlineId]),
      saveChapter: (input) => rpc('novel:saveChapter', [input]),
      contextPreview: (outlineId) => rpc('novel:contextPreview', [outlineId]),
      foreshadows: (projectId) => rpc('novel:foreshadows', [projectId]),
      foreshadowSave: (input) => rpc('novel:foreshadowSave', [input]),
      foreshadowDelete: (id) => rpc('novel:foreshadowDelete', [id]),
      summary: (outlineId) => rpc('novel:summary', [outlineId]),
      volumeSummary: (projectId, volume) => rpc('novel:volumeSummary', [projectId, volume]),
      volumeSummaries: (projectId) => rpc('novel:volumeSummaries', [projectId])
    },
    embedding: {
      status: (projectId) => rpc('embedding:status', [projectId]),
      setEnabled: (enabled) => rpc('embedding:setEnabled', [enabled]),
      rebuild: (projectId) => rpc('embedding:rebuild', [projectId])
    },
    search: {
      project: (projectId, query, limit) => rpc('search:project', [projectId, query, limit])
    },
    lint: {
      run: (outlineId, text) => rpc('lint:run', [outlineId, text])
    },
    pipeline: {
      run: (action, params) => rpc('pipeline:run', [action, params])
    },
    agent: {
      run: (params) => rpc('agent:run', [params]),
      abort: (requestId) => rpc('agent:abort', [requestId]),
      resolve: (requestId, confirmId, allow, always) =>
        rpc('agent:resolve', [requestId, confirmId, allow, always]),
      sessions: (projectId) => rpc('agent:sessions', [projectId]),
      sessionLoad: (id) => rpc('agent:sessionLoad', [id]),
      sessionSave: (session) => rpc('agent:sessionSave', [session]),
      sessionDelete: (id) => rpc('agent:sessionDelete', [id]),
      onDelta: (cb) => on('agent:delta', cb),
      onToolCall: (cb) => on('agent:toolCall', cb),
      onToolResult: (cb) => on('agent:toolResult', cb),
      onDone: (cb) => on('agent:done', cb),
      onError: (cb) => on('agent:error', cb),
      onSubEvent: (cb) => on('agent:subEvent', cb)
    },
    exporter: {
      run: async (opts) => {
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
    },
    graph: {
      project: (projectId) => rpc('graph:project', [projectId])
    },
    skills: {
      list: () => rpc('skills:list', []),
      get: (filename) => rpc('skills:get', [filename]),
      save: (filename, raw) => rpc('skills:save', [filename, raw]),
      delete: (filename) => rpc('skills:delete', [filename])
    }
  }

  window.api = api
}

installWebBridge()
