import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Badge, Button, Card, Spinner } from '@mobile/components/ui'
import { fetchMobileVersion } from '@mobile/lib/bridge'
import { apkUpdater } from '@mobile/lib/apkUpdater'
import { useConnStore } from '@mobile/lib/conn'
import { fmtTokens } from '@mobile/lib/format'
import {
  clearAllBooks,
  clearBook,
  getPrefetch,
  listCachedBooks,
  subscribePrefetch,
  type CachedBookEntry
} from '@mobile/lib/readerCache'
import { ACCENTS, APPEARANCES, useSettingsStore } from '@mobile/lib/settingsStore'

type ApkState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest'; buildAt: string | null }
  | { kind: 'available'; version: string; size: number; buildAt: string | null; notes: string[] }
  | { kind: 'downloading'; done: number; total: number }
  | { kind: 'ready' }
  | { kind: 'grant' }
  | { kind: 'server-none' }
  | { kind: 'error'; message: string }

function fmtBuildAt(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function AppearanceCard() {
  const appearance = useSettingsStore((s) => s.appearance)
  const accent = useSettingsStore((s) => s.accent)
  const setAppearance = useSettingsStore((s) => s.setAppearance)
  const setAccent = useSettingsStore((s) => s.setAccent)
  return (
      <Card className="p-4">
        <div className="text-sm font-medium text-zinc-200">外观</div>
        <p className="mt-0.5 text-[11px] text-zinc-500">保存在本机，重启 APP 后仍生效</p>
        <div className="mt-2 grid grid-cols-3 gap-1.5 rounded-lg bg-zinc-900 p-1">
        {APPEARANCES.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setAppearance(a.id)}
            className={`cursor-pointer rounded-md px-2 py-1.5 text-xs transition-colors ${
              appearance === a.id ? 'bg-amber-600 font-medium text-white' : 'text-zinc-400 active:bg-zinc-800'
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        {ACCENTS.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-label={c.label}
            title={c.label}
            onClick={() => setAccent(c.id)}
            className={`h-7 w-7 cursor-pointer rounded-full border-2 transition-[border-color,transform] ${
              accent === c.id ? 'scale-110 border-zinc-100' : 'border-transparent'
            }`}
            style={{ background: c.color }}
          />
        ))}
      </div>
    </Card>
  )
}

function FontCard() {
  const font = useSettingsStore((s) => s.font)
  const setFont = useSettingsStore((s) => s.setFont)
  return (
    <Card className="p-4">
      <div className="text-sm font-medium text-zinc-200">阅读</div>
      <p className="mt-0.5 text-[11px] text-zinc-500">正文字号，与阅读页 A-/A+ 同步生效</p>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="ghost" className="px-4 py-1.5 text-xs" onClick={() => setFont(font - 1)}>
          A-
        </Button>
        <span className="w-12 text-center text-sm tabular-nums text-zinc-300">{font}px</span>
        <Button variant="ghost" className="px-4 py-1.5 text-xs" onClick={() => setFont(font + 1)}>
          A+
        </Button>
      </div>
    </Card>
  )
}

function OfflineCacheCard() {
  const [books, setBooks] = useState<CachedBookEntry[]>([])
  const [, setTick] = useState(0)
  const [confirmAll, setConfirmAll] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void listCachedBooks().then((r) => {
        if (alive) setBooks(r)
      })
    }
    load()
    // 预取进度变化：刷新列表并重读进度（getPrefetch 非响应式，靠订阅驱动重渲染）
    const unsub = subscribePrefetch(() => {
      load()
      setTick((t) => t + 1)
    })
    return () => {
      alive = false
      unsub()
    }
  }, [])

  const doClear = async (pid: string | 'all'): Promise<void> => {
    setBusy(true)
    try {
      if (pid === 'all') await clearAllBooks()
      else await clearBook(pid)
      setConfirmAll(false)
      setConfirmId(null)
    } finally {
      setBusy(false)
      void listCachedBooks().then(setBooks)
    }
  }

  return (
    <Card className="p-4">
      <div className="text-sm font-medium text-zinc-200">离线缓存</div>
      <p className="mt-0.5 text-[11px] text-zinc-500">
        打开书的阅读页后自动整本预取正文，断网也能继续读
      </p>
      {books.length === 0 ? (
        <div className="mt-3 text-xs text-zinc-500">还没有缓存——进入某本书的「阅读」页后自动开始</div>
      ) : (
        <div className="mt-3 space-y-1.5">
          {books.map((b) => {
            const pf = getPrefetch(b.projectId)
            return (
              <div
                key={b.projectId}
                className="flex items-center gap-2 rounded-lg bg-zinc-900/60 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-zinc-200">{b.title || '（未命名）'}</div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    {pf
                      ? `缓存中 ${pf.done}/${pf.total} 章…`
                      : b.cached >= b.total
                        ? `已缓存全部 ${b.total} 章`
                        : `已缓存 ${b.cached}/${b.total} 章`}
                  </div>
                </div>
                {confirmId === b.projectId ? (
                  <Button
                    variant="ghost"
                    className="px-2.5 py-1 text-[11px] text-red-300"
                    disabled={busy}
                    onClick={() => void doClear(b.projectId)}
                  >
                    确认清除
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    className="px-2.5 py-1 text-[11px]"
                    disabled={busy}
                    onClick={() => setConfirmId(b.projectId)}
                  >
                    清除
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}
      {books.length > 0 && (
        <div className="mt-3">
          {confirmAll ? (
            <Button
              variant="ghost"
              className="px-3 py-1.5 text-xs text-red-300"
              disabled={busy}
              onClick={() => void doClear('all')}
            >
              确认清除全部缓存与阅读进度
            </Button>
          ) : (
            <Button
              variant="ghost"
              className="px-3 py-1.5 text-xs"
              disabled={busy}
              onClick={() => setConfirmAll(true)}
            >
              清除全部
            </Button>
          )}
        </div>
      )}
    </Card>
  )
}

export default function Settings() {
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
      const cur = await updater.getVersion()
      if (!remote.apk) {
        setApkState({ kind: 'server-none' })
      } else {
        // 新旧判定以 versionCode（int，分钟级 epoch，单调递增）为准；
        // versionName 相等不算最新——纯 semver 多次构建不变，仅凭它会漏更新
        const isNewer = remote.apk.versionCode
          ? remote.apk.versionCode > cur.versionCode
          : remote.apk.version !== cur.version
        if (!isNewer) {
          setApkState({ kind: 'latest', buildAt: remote.buildAt })
        } else {
          setApkState({
            kind: 'available',
            version: remote.apk.version,
            size: remote.apk.size,
            buildAt: remote.buildAt,
            notes: remote.apk.notes ?? []
          })
        }
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
      <h1 className="px-1 pt-1 text-lg font-semibold text-zinc-100">设置</h1>
      <AppearanceCard />
      <FontCard />
      <OfflineCacheCard />
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
          <div className="text-sm font-medium text-zinc-200">关于</div>
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
                <span className="text-xs text-emerald-400">
                  已是最新{fmtBuildAt(apkState.buildAt) && ` · 构建于 ${fmtBuildAt(apkState.buildAt)}`}
                </span>
              )}
              {apkState.kind === 'available' && (
                <>
                  <span className="text-xs text-amber-400">
                    新版 v{apkState.version}
                    {fmtBuildAt(apkState.buildAt) && ` · ${fmtBuildAt(apkState.buildAt)}`} ·{' '}
                    {fmtBytes(apkState.size)}
                  </span>
                  {apkState.notes.length > 0 && (
                    <div className="w-full rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
                      <div className="mb-1 text-[11px] text-zinc-500">本次更新</div>
                      <ul className="space-y-0.5">
                        {apkState.notes.slice(0, 6).map((n, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: 只读日志列表，追加序号即可稳定
                          <li key={i} className="text-[11px] leading-relaxed text-zinc-300">
                            · {n}
                          </li>
                        ))}
                      </ul>
                      {apkState.notes.length > 6 && (
                        <div className="mt-1 text-[11px] text-zinc-600">
                          等 {apkState.notes.length} 项
                        </div>
                      )}
                    </div>
                  )}
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
