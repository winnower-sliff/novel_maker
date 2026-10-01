import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Badge, Button, Card, Spinner } from '@mobile/components/ui'
import { fetchMobileVersion } from '@mobile/lib/bridge'
import { apkUpdater } from '@mobile/lib/apkUpdater'
import { useConnStore } from '@mobile/lib/conn'
import { fmtTokens } from '@mobile/lib/format'

type ApkState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'available'; version: string; size: number }
  | { kind: 'downloading'; done: number; total: number }
  | { kind: 'ready' }
  | { kind: 'grant' }
  | { kind: 'server-none' }
  | { kind: 'error'; message: string }

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

export default function More() {
  const conn = useConnStore((s) => s.conn)
  const setConn = useConnStore((s) => s.setConn)
  const [apkState, setApkState] = useState<ApkState>({ kind: 'idle' })
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const updater = apkUpdater()

  useEffect(() => {
    if (updater) void updater.getVersion().then((v) => setAppVersion(v.version))
  }, [updater])

  const { data: usage } = useQuery({
    queryKey: ['usage', 'stats'],
    queryFn: () => window.api.usage.stats(),
    refetchInterval: 60_000
  })

  const checkApk = async (): Promise<void> => {
    if (!conn || !updater) return
    setApkState({ kind: 'checking' })
    try {
      const remote = await fetchMobileVersion(conn)
      const current = (await updater.getVersion()).version
      if (!remote.apk) {
        setApkState({ kind: 'server-none' })
      } else if (remote.apk.version === current) {
        setApkState({ kind: 'latest' })
      } else {
        setApkState({ kind: 'available', version: remote.apk.version, size: remote.apk.size })
      }
    } catch (err) {
      setApkState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const installApk = async (): Promise<void> => {
    if (!updater) return
    try {
      const r = await updater.install()
      if (r?.needsGrant) setApkState({ kind: 'grant' })
      else setApkState({ kind: 'ready' })
    } catch (err) {
      setApkState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const downloadApk = async (): Promise<void> => {
    if (!conn || !updater) return
    setApkState({ kind: 'downloading', done: 0, total: 0 })
    try {
      const listener = await updater.addListener('progress', ({ done, total }) => {
        setApkState({ kind: 'downloading', done, total })
      })
      await updater.download({
        url: `${conn.baseUrl}/api/mobile/file?path=apk/NovelMaker.apk`,
        token: conn.token
      })
      await listener.remove()
      setApkState({ kind: 'ready' })
      await installApk()
    } catch (err) {
      setApkState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
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
          <div className="text-sm font-medium text-zinc-200">APP 版本</div>
          {appVersion && <Badge>v{appVersion}</Badge>}
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-zinc-500">
          界面与功能随 APP 一体更新。检查到电脑端发布新 APK 后，在此下载并按提示安装即可。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!updater ? (
            <span className="text-xs text-zinc-600">浏览器模式不支持 APP 更新（仅 APP 内可用）</span>
          ) : (
            <>
              <Button
                variant="ghost"
                className="px-3 py-1.5 text-xs"
                disabled={apkState.kind === 'checking' || apkState.kind === 'downloading'}
                onClick={() => void checkApk()}
              >
                {apkState.kind === 'checking' || apkState.kind === 'downloading' ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : (
                  '检查更新'
                )}
              </Button>
              {apkState.kind === 'latest' && (
                <span className="text-xs text-emerald-400">已是最新</span>
              )}
              {apkState.kind === 'available' && (
                <>
                  <span className="text-xs text-amber-400">
                    新版 v{apkState.version} · {fmtBytes(apkState.size)}
                  </span>
                  <Button className="px-3 py-1.5 text-xs" onClick={() => void downloadApk()}>
                    下载并安装
                  </Button>
                </>
              )}
              {apkState.kind === 'downloading' && (
                <div className="flex min-w-40 flex-1 items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-amber-500 transition-[width]"
                      style={{
                        width:
                          apkState.total > 0
                            ? `${Math.round((apkState.done / apkState.total) * 100)}%`
                            : '10%'
                      }}
                    />
                  </div>
                  <span className="text-[11px] text-zinc-500">
                    {apkState.total > 0
                      ? `${fmtBytes(apkState.done)} / ${fmtBytes(apkState.total)}`
                      : '连接中…'}
                  </span>
                </div>
              )}
              {apkState.kind === 'ready' && (
                <>
                  <span className="text-xs text-emerald-400">下载完成</span>
                  <Button className="px-3 py-1.5 text-xs" onClick={() => void installApk()}>
                    立即安装
                  </Button>
                </>
              )}
              {apkState.kind === 'grant' && (
                <>
                  <span className="text-xs text-amber-400">
                    请在授权页允许「安装未知应用」，返回后点安装
                  </span>
                  <Button className="px-3 py-1.5 text-xs" onClick={() => void installApk()}>
                    立即安装
                  </Button>
                </>
              )}
              {apkState.kind === 'server-none' && (
                <span className="text-xs text-zinc-500">电脑端还没有部署过 APK</span>
              )}
              {apkState.kind === 'error' && (
                <span className="text-xs text-red-300">失败：{apkState.message}</span>
              )}
            </>
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
