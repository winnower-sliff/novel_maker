import { create } from 'zustand'

export interface Conn {
  baseUrl: string
  token: string
}

const KEY = 'nm_conn'

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

export function storeConn(conn: Conn): void {
  localStorage.setItem(KEY, JSON.stringify(conn))
}

export function clearConn(): void {
  localStorage.removeItem(KEY)
}

interface ConnState {
  conn: Conn | null
  setConn: (conn: Conn | null) => void
}

export const useConnStore = create<ConnState>((set) => ({
  conn: loadConn(),
  setConn: (conn) => {
    if (conn) storeConn(conn)
    else clearConn()
    set({ conn })
  }
}))
