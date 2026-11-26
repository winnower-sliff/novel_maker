import type { ProviderId } from '@shared/providers'
import type { SettingsView, UsageStats } from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ErrorBox } from '../components/ErrorBox'
import { PageShell } from '../components/PageShell'
import { checkUpdate, getDownloadStatus, installUpdate, startDownload } from '../lib/apkUpdater'
import { useConnStore } from '../lib/conn'
import { useBackups, useBooks } from '../lib/queries'
import { errorText, toastError } from '../lib/toastStore'
import { useUiStore } from '../lib/uiStore'

const PROVIDER_LABEL: Record<ProviderId, string> = {
  glm: '智谱 GLM',
  deepseek: 'DeepSeek',
  custom: '自定义'
}

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''

/** 「连接」一栏的状态胶囊：探测中不下结论，拿到结果或确实连不上才显示已连接 / 未连接 */
const LINK: Record<'ok' | 'down' | 'probing', { label: string; cls: string }> = {
  ok: { label: '已连接', cls: 'bg-orange-100 text-orange-700' },
  down: { label: '未连接', cls: 'bg-red-100 text-red-600' },
  probing: { label: '正在连接…', cls: 'bg-stone-100 text-stone-500' }
}

export default function Settings() {
  const conn = useConnStore((s) => s.conn)
  const setConn = useConnStore((s) => s.setConn)
  const queryClient = useQueryClient()
  const clearSettingsAnchor = useUiStore((s) => s.clearSettingsAnchor)
  // 是否从写书页的「已归档」入口行进来：挂载时读一次、定成本次挂载的局部状态。
  // 不把 store 里的锚点放进下面 effect 的依赖——StrictMode 下 effect 会「挂载→清理→再挂载」跑两遍，
  // 依赖一变就提前收尾，第二次布局撑高后就没法重新对齐了
  const [pinArchived] = useState(() => useUiStore.getState().settingsAnchor === 'archived')

  // 锚点只管这一次进设置页：消费掉，之后从底部导航再进来不会被带着滚
  useEffect(() => {
    clearSettingsAnchor()
  }, [clearSettingsAnchor])

  // 从「已归档」入口行进来：直接滚到归档分区，省得在一长串设置里找。
  // 首帧下方内容不够高时滚不到顶，且上面的分区（模型表单等）数据回来后会撑高、把目标顶下去，
  // 所以内容尺寸一变就重新对齐，直到用户自己滚动或布局稳定（2.5 秒内没再变）为止
  useEffect(() => {
    if (!pinArchived) return
    const target = document.getElementById('settings-archived')
    if (!target) return
    let timer = 0
    const ro = new ResizeObserver(() => target.scrollIntoView({ block: 'start' }))
    for (const el of target.parentElement?.children ?? []) ro.observe(el)
    target.scrollIntoView({ block: 'start' })
    const stop = () => {
      clearTimeout(timer)
      ro.disconnect()
      window.removeEventListener('touchmove', stop)
      window.removeEventListener('wheel', stop)
    }
    timer = window.setTimeout(stop, 2500)
    window.addEventListener('touchmove', stop, { passive: true })
    window.addEventListener('wheel', stop, { passive: true })
    return stop
  }, [pinArchived])

  const { data: server, isError: serverFailed } = useQuery({
    queryKey: ['serverStatus'],
    queryFn: () => window.api.server.status(),
    refetchInterval: 30_000
  })
  const { data: stats } = useQuery({
    queryKey: ['usageStats'],
    queryFn: async (): Promise<UsageStats> => window.api.usage.stats(),
    refetchInterval: 60_000
  })
  // 探测还没回来（既没结果也没报错）时 server 是 undefined，不能当成「未连接」
  const link = serverFailed ? 'down' : server ? (server.running ? 'ok' : 'down') : 'probing'

  return (
    <PageShell title="设置" subtitle="连接、模型、备份与更新">
      {/* 连接 */}
      <Section title="连接">
        <div className="flex items-center justify-between">
          <span className="min-w-0 flex-1 truncate text-sm text-stone-600">
            {conn?.baseUrl ?? '-'}
          </span>
          <span className={`ml-3 shrink-0 rounded-full px-2 py-0.5 text-[11px] ${LINK[link].cls}`}>
            {LINK[link].label}
          </span>
        </div>
        {server && (
          <div className="mt-2 text-xs text-stone-400">
            服务版本 {server.version} · 已运行 {Math.floor(server.uptimeS / 3600)}h
            {Math.floor((server.uptimeS % 3600) / 60)}m
          </div>
        )}
        <button
          type="button"
          className="mt-3 w-full rounded-xl border border-orange-100 py-2.5 text-sm text-stone-500"
          onClick={() => {
            setConn(null)
            queryClient.clear()
          }}
        >
          断开连接
        </button>
      </Section>

      {/* 模型 */}
      <Section title="写作模型">
        <ModelForm />
      </Section>

      {/* 范文库在底部导航的「范文」页（pages/Samples.tsx） */}

      <ArchivedBooks />

      {/* 用量 */}
      <Section title="用量">
        {stats && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="近 5 小时" value={`${stats.window5h.requests} 次请求`} />
              <Stat label="累计" value={`${stats.totals.requests} 次请求`} />
              <Stat
                label="累计输入"
                value={`${(stats.totals.inputTokens / 10000).toFixed(1)} 万 tokens`}
              />
              <Stat
                label="累计输出"
                value={`${(stats.totals.outputTokens / 10000).toFixed(1)} 万 tokens`}
              />
            </div>
            {stats.byPurpose.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {stats.byPurpose.map((g) => (
                  <span
                    key={g.key}
                    className="rounded-full bg-orange-100 px-2.5 py-1 text-[11px] text-stone-500"
                  >
                    {g.key} {g.requests}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </Section>

      {/* APP 更新 */}
      <Section title="APP">
        <UpdateRow />
        <div className="mt-2 text-xs text-stone-400">当前版本 {APP_VERSION}</div>
      </Section>

      {/* 备份与恢复 */}
      <Section title="备份与恢复">
        <BackupSection />
      </Section>
    </PageShell>
  )
}

/** 已归档的书：隐藏于书架，此处可恢复或彻底删除 */
function ArchivedBooks() {
  const qc = useQueryClient()
  const { data: books } = useBooks()
  const archived = (books ?? []).filter((b) => b.archived)
  const [busy, setBusy] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  if (archived.length === 0) return null
  const restore = async (id: string) => {
    setBusy(id)
    try {
      await window.api.book.update(id, { archived: false })
      await qc.invalidateQueries({ queryKey: ['books'] })
    } catch (e) {
      toastError(e, '恢复失败')
    } finally {
      setBusy('')
    }
  }
  const wipe = async (id: string) => {
    setBusy(id)
    try {
      await window.api.book.delete(id, true)
      setConfirmDel(null)
      await qc.invalidateQueries({ queryKey: ['books'] })
    } catch (e) {
      toastError(e, '删除失败')
    } finally {
      setBusy('')
    }
  }
  return (
    <Section id="settings-archived" title={`已归档的书（${archived.length}）`}>
      <div className="space-y-2">
        {archived.map((b) => (
          <div key={b.id} className="rounded-xl bg-orange-50 p-2.5">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-stone-700">{b.title || '未命名'}</div>
                <div className="mt-0.5 text-[11px] text-stone-400">
                  {confirmDel === b.id
                    ? '删除后无法找回（会自动留一份当日快照）'
                    : '已归档，内容保留'}
                </div>
              </div>
              {confirmDel === b.id ? (
                <>
                  <button
                    type="button"
                    disabled={busy === b.id}
                    className="shrink-0 rounded-lg bg-red-100 px-3 py-1.5 text-[11px] text-red-600 disabled:opacity-50"
                    onClick={() => void wipe(b.id)}
                  >
                    确认删除
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded-lg border border-orange-200 px-3 py-1.5 text-[11px] text-stone-500"
                    onClick={() => setConfirmDel(null)}
                  >
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busy === b.id}
                    className="shrink-0 rounded-lg border border-orange-200 px-3 py-1.5 text-[11px] text-stone-500 disabled:opacity-50"
                    onClick={() => void restore(b.id)}
                  >
                    恢复
                  </button>
                  <button
                    type="button"
                    className="shrink-0 text-[11px] text-stone-400"
                    onClick={() => setConfirmDel(b.id)}
                  >
                    彻底删除
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Section({
  id,
  title,
  children
}: {
  id?: string
  title: string
  children: React.ReactNode
}) {
  return (
    <div id={id} className="mb-5 scroll-mt-3 rounded-2xl border border-orange-100 bg-white p-4">
      <div className="mb-3 text-xs font-semibold text-stone-500">{title}</div>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-orange-50 p-3">
      <div className="text-[11px] text-stone-400">{label}</div>
      <div className="mt-0.5 text-sm text-stone-700">{value}</div>
    </div>
  )
}

function ModelForm() {
  const queryClient = useQueryClient()
  const {
    data: view,
    error,
    isError,
    refetch: refetchView
  } = useQuery({
    queryKey: ['settings'],
    queryFn: async (): Promise<SettingsView> => window.api.settings.get()
  })
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const {
    data: probeResult,
    isFetching: probing,
    refetch
  } = useQuery({
    queryKey: ['models', view?.provider],
    enabled: !!view,
    queryFn: () => {
      if (!view) throw new Error('settings 未加载')
      return window.api.models.probe({ provider: view.provider })
    },
    staleTime: 60_000,
    retry: false
  })

  if (!view) {
    return isError ? (
      <ErrorBox error={error} onRetry={() => refetchView()} />
    ) : (
      <div className="py-4 text-center text-xs text-stone-400">加载中…</div>
    )
  }

  const profile = view.profiles[view.provider]
  const currentModel = model || profile.defaultModel
  const currentBase = baseUrl || profile.baseUrl
  const rawList = probeResult?.models ?? []
  const modelList =
    currentModel && !rawList.includes(currentModel) ? [currentModel, ...rawList] : rawList

  const persist = async (nextModel: string) => {
    await window.api.settings.save({
      provider: view.provider,
      profiles: {
        ...view.profiles,
        [view.provider]: { ...profile, baseUrl: currentBase, defaultModel: nextModel }
      },
      ...(apiKey.trim() ? { apiKeys: { [view.provider]: apiKey.trim() } } : {})
    })
    if (apiKey.trim()) setApiKey('')
    queryClient.invalidateQueries({ queryKey: ['settings'] })
  }

  const save = async () => {
    setBusy(true)
    setMsg('')
    try {
      await persist(currentModel)
      setMsg('已保存')
    } catch (e) {
      setMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const pickModel = async (m: string) => {
    setModel(m)
    setMsg('')
    try {
      await persist(m)
      setMsg('已保存')
    } catch (e) {
      setMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 刷新列表 = 隐性连接测试：先把新填的 Key/地址保存（probe 才能用上），再拉列表
  const refresh = async () => {
    setBusy(true)
    setMsg('')
    try {
      if (apiKey.trim() || baseUrl) {
        await window.api.settings.save({
          provider: view.provider,
          profiles: {
            ...view.profiles,
            [view.provider]: { ...profile, baseUrl: currentBase }
          },
          ...(apiKey.trim() ? { apiKeys: { [view.provider]: apiKey.trim() } } : {})
        })
        setApiKey('')
        queryClient.invalidateQueries({ queryKey: ['settings'] })
      }
      const r = await refetch()
      const list = r.data?.models ?? []
      if (list.length === 0) setMsg('没拉到模型列表：检查 Key 与地址')
      else if (!model && !profile.defaultModel) await pickModel(list[0] ?? '')
    } catch (e) {
      setMsg(`连接失败：${errorText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="mb-3 flex gap-1.5">
        {(['glm', 'deepseek', 'custom'] as ProviderId[]).map((p) => (
          <button
            key={p}
            type="button"
            className={
              'flex-1 rounded-lg py-2 text-xs ' +
              (view.provider === p ? 'bg-orange-600 text-white' : 'bg-orange-100 text-stone-500')
            }
            onClick={async () => {
              try {
                await window.api.settings.save({ provider: p })
              } catch (e) {
                toastError(e, '切换失败')
                return
              }
              setModel('')
              setBaseUrl('')
              queryClient.invalidateQueries({ queryKey: ['settings'] })
            }}
          >
            {PROVIDER_LABEL[p]}
          </button>
        ))}
      </div>

      {view.provider === 'custom' && (
        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] text-stone-400">API 地址（OpenAI 兼容）</span>
          <input
            className="w-full rounded-xl border border-orange-100 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-700"
            placeholder="https://…/v1"
            value={currentBase}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
      )}

      <label className="mb-3 block">
        <span className="mb-1 block text-[11px] text-stone-400">
          API Key {view.apiKeyMasked ? `（已配置 ${view.apiKeyMasked}）` : '（未配置）'}
        </span>
        <input
          type="password"
          className="w-full rounded-xl border border-orange-100 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-700"
          placeholder="sk-…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>

      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] text-stone-400">模型</span>
          <button
            type="button"
            disabled={probing || busy}
            className="rounded-lg px-2 py-1 text-[11px] text-orange-600 disabled:opacity-50"
            onClick={refresh}
          >
            {probing || busy ? '获取中…' : '刷新列表'}
          </button>
        </div>
        {modelList.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {modelList.map((m) => (
              <button
                key={m}
                type="button"
                className={
                  'rounded-full px-3 py-1.5 text-xs ' +
                  (currentModel === m ? 'bg-orange-600 text-white' : 'bg-orange-100 text-stone-500')
                }
                onClick={() => pickModel(m)}
              >
                {m}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-xs text-stone-400">
            填好 API Key{view.provider === 'custom' ? '与 API 地址' : ''}
            后点「刷新列表」自动获取可选模型
          </div>
        )}
        {probeResult && modelList.length > 0 && (
          <div className="mt-1.5 text-[11px] text-stone-400">
            {probeResult.source === 'endpoint'
              ? '在线模型列表'
              : '内置清单（未连上端点，填 Key 后刷新验证）'}
          </div>
        )}
        {view.provider === 'custom' && (
          <div className="mt-2 flex gap-1.5">
            <input
              className="min-w-0 flex-1 rounded-xl border border-orange-100 bg-white px-3 py-2 text-xs outline-none focus:border-orange-700"
              placeholder="列表没有？手填模型名"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
            <button
              type="button"
              disabled={!manual.trim()}
              className="shrink-0 rounded-xl bg-orange-100 px-3 text-xs text-stone-600 disabled:opacity-50"
              onClick={() => {
                if (manual.trim()) {
                  pickModel(manual.trim())
                  setManual('')
                }
              }}
            >
              用这个
            </button>
          </div>
        )}
      </div>

      {msg && <div className="mb-3 text-xs text-orange-600">{msg}</div>}

      <button
        type="button"
        disabled={busy}
        className="w-full rounded-xl bg-orange-600 py-2.5 text-sm font-medium disabled:opacity-50"
        onClick={save}
      >
        {busy ? '…' : '保存'}
      </button>
    </div>
  )
}

const BACKUP_KIND_LABEL: Array<[RegExp, string]> = [
  [/^daily$/, '每日备份'],
  [/^manual$/, '手动备份'],
  [/^pre-migrate$/, '升级前'],
  [/^pre-restore$/, '恢复前']
]

/** 删除类操作前的自动快照 tag 形如 del-chapter / book-1a2b3c4d，统一显示为「删除前」 */
function backupLabel(tag: string): string {
  const hit = BACKUP_KIND_LABEL.find(([re]) => re.test(tag))
  return hit?.[1] ?? '删除前'
}

function backupSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function backupTime(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function BackupSection() {
  const queryClient = useQueryClient()
  const { data: backups, isPending, error, isError, refetch } = useBackups()
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [confirmName, setConfirmName] = useState('')

  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

  const create = async () => {
    setBusy('create')
    setMsg('')
    try {
      await window.api.backup.create()
      setMsg('已备份')
      void queryClient.invalidateQueries({ queryKey: ['backups'] })
    } catch (e) {
      setMsg(`备份失败：${errText(e)}`)
    } finally {
      setBusy('')
    }
  }

  const restore = async () => {
    setBusy('restore')
    setMsg('')
    try {
      await window.api.backup.restore(confirmName)
      location.reload()
    } catch (e) {
      setMsg(`恢复失败：${errText(e)}`)
      setConfirmName('')
    } finally {
      setBusy('')
    }
  }

  const shown = (backups ?? []).slice(0, 8)

  return (
    <div>
      <div className="text-xs leading-relaxed text-stone-500">
        电脑端每天开着会自动备份一次；删书、删线、删卡之前也会自动留一份快照。
        换电脑或重装时，把数据目录里的备份文件拷走即可。
      </div>
      {msg ? <div className="mt-2 text-xs text-stone-700">{msg}</div> : null}
      <button
        type="button"
        disabled={busy !== ''}
        className="mt-3 rounded-lg bg-orange-600 px-3 py-2 text-xs text-white disabled:opacity-50"
        onClick={create}
      >
        {busy === 'create' ? '正在备份…' : '立即备份'}
      </button>

      {isPending ? (
        <div className="mt-3 text-xs text-stone-400">加载中…</div>
      ) : isError && !backups ? (
        <ErrorBox error={error} onRetry={() => refetch()} />
      ) : shown.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {shown.map((b) => (
            <div
              key={b.name}
              className="flex items-center gap-2 rounded-lg bg-orange-50 px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-stone-700">
                  {backupLabel(b.tag)} · {backupTime(b.at)}
                </div>
                <div className="mt-0.5 text-[11px] text-stone-400">{backupSize(b.size)}</div>
              </div>
              <button
                type="button"
                disabled={busy !== ''}
                className="shrink-0 rounded-lg border border-orange-200 px-2.5 py-1.5 text-xs text-stone-600 disabled:opacity-50"
                onClick={() => {
                  setConfirmName(b.name)
                  setMsg('')
                }}
              >
                恢复
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 text-xs text-stone-400">还没有备份</div>
      )}

      {confirmName ? (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs leading-relaxed text-stone-700">
          用这份备份覆盖现在的全部数据？恢复前会先给现在的数据留一份。
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy !== ''}
              className="rounded-lg bg-red-600 px-2.5 py-1.5 text-white disabled:opacity-50"
              onClick={restore}
            >
              {busy === 'restore' ? '正在恢复…' : '确认恢复'}
            </button>
            <button
              type="button"
              disabled={busy !== ''}
              className="rounded-lg border border-red-200 px-2.5 py-1.5 text-stone-600 disabled:opacity-50"
              onClick={() => setConfirmName('')}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function UpdateRow() {
  const [state, setState] = useState<
    'idle' | 'checking' | 'latest' | 'found' | 'downloading' | 'ready' | 'error'
  >('idle')
  const [note, setNote] = useState('')
  const [apkUrl, setApkUrl] = useState('')
  const [apkSize, setApkSize] = useState(0)
  const [apkVc, setApkVc] = useState(0)

  // 检查更新：进设置页自动跑一次；下载中/已下载未装的状态经原生 status 自动恢复
  // （下载文件按 versionCode 隔离，旧版本残留文件不会被误判成新版已就绪）
  const check = async () => {
    setState('checking')
    const r = await checkUpdate()
    if (r.state === 'found') {
      setApkUrl(r.url)
      setApkSize(r.size)
      setApkVc(r.versionCode)
      const s = await getDownloadStatus(r.versionCode)
      if (s && !s.downloading && r.size > 0 && s.size >= r.size) {
        setState('ready')
        setNote(`新版 ${r.version} 已下载，点击安装`)
        return
      }
      if (s?.downloading) {
        setState('downloading')
        setNote('继续下载中…')
        return
      }
      setState('found')
      setNote(`发现新版 ${r.version}`)
    } else if (r.state === 'latest') {
      setState('latest')
      setNote('已是最新版')
    } else {
      setState('error')
      setNote(r.error ?? '检查失败')
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: 进设置页只查一次更新，手点按钮走 check()
  useEffect(() => {
    void check()
  }, [])

  const download = async () => {
    setState('downloading')
    setNote('下载中…')
    try {
      await startDownload(apkUrl, apkVc)
    } catch (e) {
      setState('error')
      setNote(e instanceof Error ? e.message : String(e))
    }
  }

  // 下载进度轮询（原生线程执行，状态不随页面/WebView 重载丢失）
  useEffect(() => {
    if (state !== 'downloading') return
    const t = setInterval(async () => {
      const s = await getDownloadStatus(apkVc)
      if (!s) return
      if (s.downloading) {
        setNote(
          s.total > 0
            ? `下载中 ${Math.round((s.done / s.total) * 100)}%`
            : `下载中 ${(s.done / 1048576).toFixed(1)} MB`
        )
        return
      }
      if (apkSize > 0 && s.size >= apkSize) {
        setState('ready')
        setNote('下载完成，点击安装')
      } else if (s.error) {
        setState('error')
        setNote(`下载失败：${s.error}`)
      }
    }, 800)
    return () => clearInterval(t)
  }, [state, apkSize, apkVc])

  const install = async () => {
    const r = await installUpdate(apkVc)
    if (r.needsGrant) setNote('请先在系统里允许本应用安装未知应用，再回来点安装')
  }

  return (
    <div>
      {state === 'idle' || state === 'checking' || state === 'latest' || state === 'error' ? (
        <button
          type="button"
          disabled={state === 'checking'}
          className="w-full rounded-xl border border-orange-100 py-2.5 text-sm text-stone-600 disabled:opacity-50"
          onClick={() => void check()}
        >
          {state === 'checking' ? '检查中…' : '检查更新'}
        </button>
      ) : state === 'found' ? (
        <button
          type="button"
          className="w-full rounded-xl bg-orange-600 py-2.5 text-sm font-medium"
          onClick={() => void download()}
        >
          {note}
        </button>
      ) : state === 'downloading' ? (
        <button
          type="button"
          disabled
          className="w-full rounded-xl border border-orange-100 py-2.5 text-sm text-stone-500"
        >
          {note}
        </button>
      ) : (
        <button
          type="button"
          className="w-full rounded-xl bg-orange-600 py-2.5 text-sm font-medium"
          onClick={() => void install()}
        >
          {note}
        </button>
      )}
      {state === 'error' && <div className="mt-2 text-xs text-red-600">{note}</div>}
    </div>
  )
}
