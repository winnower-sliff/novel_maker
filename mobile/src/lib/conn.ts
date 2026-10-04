import { create } from 'zustand'
import { loadJson, removeJson, saveJson } from '@mobile/lib/persist'

export interface Conn {
  baseUrl: string
  token: string
}

const KEY = 'nm_conn'

/** 家里电脑的 Tailscale 地址（APK 专用预设，改端口时在连接页可改） */
export const DEFAULT_BASE_URL = 'http://100.100.62.8:3910'

/** 同步镜像读：供 main.tsx 的 bridge 安装判断与 bridge 请求鉴权使用（写入侧双写保证一致） */
export function loadConn(): Conn | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Conn>
    if (!parsed.baseUrl || !parsed.token) return null
    return { baseUrl: parsed.baseUrl.replace(/\/+$/, ''), token: parsed.token }
  } catch {
    return null
  }
}

function storeConn(conn: Conn): void {
  localStorage.setItem(KEY, JSON.stringify(conn))
}

function clearConn(): void {
  localStorage.removeItem(KEY)
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
      storeConn(conn)
      void saveJson(KEY, conn)
    } else {
      clearConn()
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
  const restored =
    raw?.baseUrl && raw?.token
      ? { baseUrl: raw.baseUrl.replace(/\/+$/, ''), token: raw.token }
      : null
  if (!dirty && restored) {
    useConnStore.setState({ conn: restored, ready: true })
    // main.tsx 的同步 loadConn 只看 localStorage 镜像：镜像被杀丢时 bridge 未装，这里补装
    void import('./bridge').then((m) => m.installBridge())
  } else {
    useConnStore.setState({ ready: true })
  }
  unsubDirty()
})()
