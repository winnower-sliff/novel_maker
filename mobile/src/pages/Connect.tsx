import { useState } from 'react'
import { useConnStore } from '@mobile/lib/conn'
import { Button, Card, Input } from '@mobile/components/ui'

export default function Connect() {
  const setConn = useConnStore((s) => s.setConn)
  const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem('nm_last_base') ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const connect = async (): Promise<void> => {
    const base = baseUrl.trim().replace(/\/+$/, '')
    if (!base || !password) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${base}/api/mobile/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password })
      })
      const data = (await res.json().catch(() => null)) as {
        token?: string
        error?: string
      } | null
      if (!res.ok || !data?.token) throw new Error(data?.error ?? `HTTP ${res.status}`)
      localStorage.setItem('nm_last_base', base)
      setConn({ baseUrl: base, token: data.token })
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm p-5">
        <h1 className="text-lg font-semibold text-zinc-100">Novel Maker</h1>
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          连接家里电脑（Tailscale IP + 电脑端设置的端口）。首次使用需在桌面端「设置 · 手机访问」里开启服务器并设置访问密码。
        </p>
        <div className="mt-4 space-y-3">
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://100.x.x.x:8787"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
          />
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="访问密码"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void connect()
            }}
          />
          {error && <div className="text-xs leading-5 text-red-300">{error}</div>}
          <Button className="w-full" disabled={busy || !baseUrl.trim() || !password} onClick={() => void connect()}>
            {busy ? '连接中…' : '连接'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
