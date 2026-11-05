import { create } from 'zustand'
import { loadJson, removeJson, saveJson } from './persist'

export interface Conn {
  baseUrl: string
}

const KEY = 'nm_conn'

/** 家里电脑的 Tailscale 地址（预置默认值，连接页可改；v2 无鉴权） */
export const DEFAULT_BASE_URL = 'http://100.100.62.8:3910'

function normalize(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** 同步镜像读：供 main.tsx 的 bridge 安装判断与请求鉴权使用（写入侧双写保证一致） */
export function loadConn(): Conn | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Conn>
    if (!parsed.baseUrl) return null
    return { baseUrl: normalize(parsed.baseUrl) }
  } catch {
    return null
  }
}

interface ConnState {
  conn: Conn | null
  /** 持久化恢复完成：localStorage 丢失时经 Preferences 异步补救，恢复中不渲染路由 */
  ready: boolean
  setConn: (conn: Conn | null) => void
}

export const useConnStore = create<ConnState>((set) => ({
  conn: loadConn(),
  ready: loadConn() !== null,
  setConn: (conn) => {
    if (conn) {
      localStorage.setItem(KEY, JSON.stringify(conn))
      void saveJson(KEY, conn)
    } else {
      localStorage.removeItem(KEY)
      void removeJson(KEY)
    }
    set({ conn, ready: true })
  }
}))

// 异步水合：WebView localStorage 丢失时从 Capacitor Preferences 补回连接；
// 用户已手动连接（dirty）则不回填旧连接。
let dirty = false
const unsubDirty = useConnStore.subscribe(() => {
  dirty = true
})

void (async () => {
  const raw = await loadJson<Partial<Conn>>(KEY)
  const restored = raw?.baseUrl ? { baseUrl: normalize(raw.baseUrl) } : null
  if (!dirty && restored) {
    useConnStore.setState({ conn: restored, ready: true })
    void import('./bridge').then((m) => m.installBridge())
  } else {
    useConnStore.setState({ ready: true })
  }
  unsubDirty()
})()
