import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge, Button, Card, Spinner } from '@mobile/components/ui'
import { fetchMobileVersion } from '@mobile/lib/bridge'
import { useConnStore } from '@mobile/lib/conn'
import { fmtTokens } from '@mobile/lib/format'

declare const __APP_VERSION__: string

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest'; version: string }
  | { kind: 'available'; version: string }
  | { kind: 'server-none' }
  | { kind: 'error'; message: string }

export default function More() {
  const conn = useConnStore((s) => s.conn)
  const setConn = useConnStore((s) => s.setConn)
  const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' })

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
        setUpdate({ kind: 'available', version: remote.version })
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
          界面资源从电脑静默更新，无需重新安装 APP。电脑端运行 mobile:bundle 后，这里即可检查到新版本。
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
              发现新版本 v{update.version}，重启 APP 后生效
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
