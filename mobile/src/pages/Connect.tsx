import { useState } from 'react'
import { useConnStore, DEFAULT_BASE_URL } from '@mobile/lib/conn'

/** 连接页：地址输入 + 测试连接（v2 无鉴权，Tailscale 直连） */
export default function Connect() {
  const setConn = useConnStore((s) => s.setConn)
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function connect() {
    setTesting(true)
    setError(null)
    try {
      const url = baseUrl.replace(/\/+$/, '')
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`服务器响应异常（HTTP ${res.status}）`)
      const body = (await res.json()) as { ok?: boolean; version?: string }
      if (!body.ok) throw new Error('这不是小说工坊服务器')
      setConn({ baseUrl: url })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex h-full flex-col justify-center gap-6 px-8">
      <div className="text-center">
        <div className="text-5xl">📖</div>
        <h1 className="mt-3 text-2xl font-bold">小说工坊</h1>
        <p className="mt-1 text-sm text-stone-500">连接家里电脑上的写作服务器</p>
      </div>

      <div className="space-y-2">
        <label className="text-sm text-stone-500" htmlFor="addr">
          服务器地址
        </label>
        <input
          id="addr"
          className="w-full rounded-xl border border-orange-200 bg-white px-4 py-3 text-base focus:border-orange-500 focus:outline-none"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://100.x.x.x:3910"
          inputMode="url"
          autoCapitalize="off"
          spellCheck={false}
        />
        <p className="text-xs text-stone-500">
          电脑托盘状态行会显示地址；Tailscale 网络内直接可达。
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      <button
        type="button"
        disabled={testing || !baseUrl}
        onClick={() => void connect()}
        className="rounded-xl bg-orange-600 py-3.5 text-base font-semibold text-white active:bg-orange-700 disabled:opacity-50"
      >
        {testing ? '连接中…' : '连接'}
      </button>
    </div>
  )
}
