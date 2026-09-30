import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Badge, Button, Card, Spinner } from '@mobile/components/ui'
import { fetchMobileVersion } from '@mobile/lib/bridge'
import { useConnStore } from '@mobile/lib/conn'
import { fmtRelative, fmtTokens } from '@mobile/lib/format'

declare const __APP_VERSION__: string

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest'; version: string }
  | { kind: 'available'; version: string; fileCount: number; totalBytes: number }
  | { kind: 'server-none' }
  | { kind: 'error'; message: string }

interface LastUpdate {
  ok: boolean
  version: string | null
  files: number
  bytes: number
  durationMs: number
  error: string | null
  at: number
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function readLastUpdate(): LastUpdate | null {
  try {
    const raw = localStorage.getItem('nm_last_update')
    return raw ? (JSON.parse(raw) as LastUpdate) : null
  } catch {
    return null
  }
}

export default function More() {
  const conn = useConnStore((s) => s.conn)
  const setConn = useConnStore((s) => s.setConn)
  const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' })
  const [lastUpdate, setLastUpdate] = useState<LastUpdate | null>(readLastUpdate)

  // 回到此页时刷新「上次启动更新」
  useEffect(() => {
    setLastUpdate(readLastUpdate())
  }, [])

  const { data: usage } = useQuery({
    queryKey: ['usage', 'stats'],
    queryFn: () => window.api.usage.stats(),
    refetchInterval: 60_000
  })

  const checkUpdate = async (): Promise<void> => {
    if (!conn) return
    setUpdate({ kind: 'checking' })
    try {
      const remote = await fetchMobileVersion(conn)
      if (!remote.version) {
        setUpdate({ kind: 'server-none' })
      } else if (remote.version === __APP_VERSION__) {
        setUpdate({ kind: 'latest', version: remote.version })
      } else {
        setUpdate({
          kind: 'available',
          version: remote.version,
          fileCount: remote.files.length,
          totalBytes: remote.files.reduce((s, f) => s + f.size, 0)
        })
      }
    } catch (err) {
      setUpdate({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="space-y-3 p-3">
      <Card className="p-4">
        <div className="text-sm font-medium text-zinc-200">连接</div>
        {conn ? (
          <>
            <div className="mt-2 break-all font-mono text-xs text-zinc-400">{conn.baseUrl}</div>
            <Button variant="ghost" className="mt-3 px-3 py-1.5 text-xs" onClick={() => setConn(null)}>
              断开并返回连接页
            </Button>
          </>
        ) : (
          <div className="mt-2 text-xs text-zinc-500">未连接</div>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium text-zinc-200">界面版本</div>
          <Badge>v{__APP_VERSION__}</Badge>
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-zinc-500">
          每次启动 APP 时自动检查并下载新版界面，下载完成后自动应用。电脑端运行 mobile:bundle 发布新包即可。
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="ghost"
            className="px-3 py-1.5 text-xs"
            disabled={update.kind === 'checking'}
            onClick={() => void checkUpdate()}
          >
            {update.kind === 'checking' ? <Spinner className="h-3.5 w-3.5" /> : '检查更新'}
          </Button>
          {update.kind === 'latest' && (
            <span className="text-xs text-emerald-400">已是最新（{update.version}）</span>
          )}
          {update.kind === 'available' && (
            <span className="text-xs text-amber-400">
              发现新版本 v{update.version} · {update.fileCount} 个文件 · 共 {fmtBytes(update.totalBytes)}
              ，下次启动自动应用
            </span>
          )}
          {update.kind === 'server-none' && (
            <span className="text-xs text-zinc-500">电脑端还没有部署过界面包</span>
          )}
          {update.kind === 'error' && (
            <span className="text-xs text-red-300">{update.message}</span>
          )}
        </div>
      </Card>

      {lastUpdate && (
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-zinc-200">上次启动更新</div>
            <span className="text-[11px] text-zinc-600">{fmtRelative(lastUpdate.at)}</span>
          </div>
          {lastUpdate.ok ? (
            <div className="mt-2 text-xs leading-5 text-zinc-400">
              <span className="text-emerald-400">成功</span>
              {lastUpdate.version && <> · v{lastUpdate.version}</>}
              {lastUpdate.files > 0 && (
                <>
                  {' '}
                  · {lastUpdate.files} 个文件 · {fmtBytes(lastUpdate.bytes)}
                </>
              )}
              {lastUpdate.durationMs > 0 && <> · {(lastUpdate.durationMs / 1000).toFixed(1)}s</>}
            </div>
          ) : (
            <div className="mt-2 text-xs leading-5 text-red-300">
              失败{lastUpdate.error ? `：${lastUpdate.error}` : ''}
            </div>
          )}
        </Card>
      )}

      {usage && (
        <Card className="p-4">
          <div className="text-sm font-medium text-zinc-200">用量</div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-zinc-900 p-2.5">
              <div className="text-base font-semibold text-zinc-100">
                {fmtTokens(usage.totals.inputTokens + usage.totals.outputTokens)}
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">总 tokens</div>
            </div>
            <div className="rounded-lg bg-zinc-900 p-2.5">
              <div className="text-base font-semibold text-zinc-100">{usage.totals.requests}</div>
              <div className="mt-0.5 text-[11px] text-zinc-500">总请求</div>
            </div>
            <div className="rounded-lg bg-zinc-900 p-2.5">
              <div className="text-base font-semibold text-zinc-100">
                {fmtTokens(usage.window5h.inputTokens + usage.window5h.outputTokens)}
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">5 小时窗口</div>
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}
