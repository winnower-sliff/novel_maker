import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { Book, SampleFileInfo, SampleInfo, SettingsView, UsageStats } from '@shared/types'
import type { ProviderId } from '@shared/providers'
import { useConnStore } from '../lib/conn'
import { checkUpdate, downloadUpdate, installUpdate } from '../lib/apkUpdater'
import { useUiStore } from '../lib/uiStore'
import { useBooks } from '../lib/queries'
import { SampleReader } from '../components/SampleReader'

const PROVIDER_LABEL: Record<ProviderId, string> = {
  glm: '智谱 GLM',
  deepseek: 'DeepSeek',
  custom: '自定义'
}

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''

export default function Settings() {
  const conn = useConnStore((s) => s.conn)
  const setConn = useConnStore((s) => s.setConn)
  const setTab = useUiStore((s) => s.setTab)
  const queryClient = useQueryClient()

  const { data: server } = useQuery({
    queryKey: ['serverStatus'],
    queryFn: () => window.api.server.status(),
    refetchInterval: 30_000
  })
  const { data: stats } = useQuery({
    queryKey: ['usageStats'],
    queryFn: async (): Promise<UsageStats> => window.api.usage.stats(),
    refetchInterval: 60_000
  })

  return (
    <div className="px-4 py-5 pb-10">
      <div className="mb-6 flex items-center justify-between">
        <div className="text-base font-semibold">设置</div>
        <button
          type="button"
          className="rounded-lg px-3 py-1.5 text-xs text-stone-500"
          onClick={() => setTab('shelf')}
        >
          返回书架
        </button>
      </div>

      {/* 连接 */}
      <Section title="连接">
        <div className="flex items-center justify-between">
          <span className="min-w-0 flex-1 truncate text-sm text-stone-600">{conn?.baseUrl ?? '-'}</span>
          <span
            className={
              'ml-3 shrink-0 rounded-full px-2 py-0.5 text-[11px] ' +
              (server?.running ? 'bg-orange-900/60 text-orange-700' : 'bg-red-100 text-red-600')
            }
          >
            {server?.running ? '已连接' : '未连接'}
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

      {/* 范文库 */}
      <Section title="范文库">
        <SampleLib />
      </Section>

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
                  <span key={g.key} className="rounded-full bg-orange-100 px-2.5 py-1 text-[11px] text-stone-500">
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
    </div>
  )
}

/** 已归档的书：隐藏于书架，此处可恢复 */
function ArchivedBooks() {
  const qc = useQueryClient()
  const { data: books } = useBooks()
  const archived = (books ?? []).filter((b) => b.archived)
  const [busy, setBusy] = useState('')
  if (archived.length === 0) return null
  const restore = async (id: string) => {
    setBusy(id)
    try {
      await window.api.book.update(id, { archived: false })
      await qc.invalidateQueries({ queryKey: ['books'] })
    } finally {
      setBusy('')
    }
  }
  return (
    <Section title={`已归档的书（${archived.length}）`}>
      <div className="space-y-2">
        {archived.map((b) => (
          <div key={b.id} className="flex items-center gap-2 rounded-xl bg-orange-50 p-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-stone-700">{b.title || '未命名'}</div>
              <div className="mt-0.5 text-[11px] text-stone-400">归档于书架，内容保留</div>
            </div>
            <button
              type="button"
              disabled={busy === b.id}
              className="shrink-0 rounded-lg border border-orange-200 px-3 py-1.5 text-[11px] text-stone-500 disabled:opacity-50"
              onClick={() => void restore(b.id)}
            >
              恢复
            </button>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 rounded-2xl border border-orange-100 bg-white p-4">
      <div className="mb-3 text-xs font-semibold text-stone-500">{title}</div>
      {children}
    </div>
  )
}

function SampleLib() {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [reading, setReading] = useState<SampleInfo | null>(null)

  const { data: samples } = useQuery({
    queryKey: ['samples'],
    queryFn: async (): Promise<SampleInfo[]> => window.api.sample.list()
  })
  const { data: files } = useQuery({
    queryKey: ['importFiles'],
    queryFn: async (): Promise<SampleFileInfo[]> => window.api.sample.listDir()
  })
  const { data: books } = useQuery({
    queryKey: ['books'],
    queryFn: async (): Promise<Book[]> => window.api.book.list()
  })

  const bookTitle = (id: string | null | undefined) =>
    books?.find((b) => b.id === id)?.title ?? '（书已删除）'

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['samples'] })
    queryClient.invalidateQueries({ queryKey: ['importFiles'] })
    queryClient.invalidateQueries({ queryKey: ['books'] })
  }

  const doImport = async (fileName: string) => {
    setBusy(fileName)
    setMsg('')
    try {
      await window.api.sample.import({ fileName })
      setMsg('已导入')
      refresh()
    } catch (e) {
      setMsg(`导入失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
    }
  }

  const doToggle = async (bookId: string, sampleId: string, nextIds: string[]) => {
    if (!bookId) return
    setBusy(sampleId + bookId)
    try {
      await window.api.sample.attach(bookId, nextIds)
      refresh()
    } catch (e) {
      setMsg(`绑定失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
    }
  }

  const doDelete = async (sampleId: string) => {
    setBusy(sampleId)
    try {
      await window.api.sample.delete(sampleId)
      setConfirmDel(null)
      setMsg('已删除')
      refresh()
    } catch (e) {
      setMsg(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
    }
  }

  return (
    <div>
      {samples && samples.length > 0 ? (
        <div className="space-y-3">
          {samples.map((s) => {
            const boundCount = (books ?? []).filter((b) => b.sampleSources?.includes(s.id)).length
            return (
              <div key={s.id} className="rounded-xl bg-orange-50 p-3">
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    className="min-w-0 text-left"
                    onClick={() => setReading(s)}
                  >
                    <div className="truncate text-sm text-stone-700 underline decoration-orange-300 decoration-dotted underline-offset-4">
                      {s.name}
                    </div>
                    <div className="mt-0.5 text-[11px] text-stone-400">
                      {s.chars.toLocaleString()} 字
                      {s.chapterCount ? ` · ${s.chapterCount} 章` : ''}
                      {boundCount ? ` · 已绑定 ${boundCount} 本书` : ''}
                      {' · 点看'}
                    </div>
                  </button>
                  {confirmDel === s.id ? null : (
                    <button type="button" className="shrink-0 text-[11px] text-stone-400" onClick={() => setConfirmDel(s.id)}>
                      删除
                    </button>
                  )}
                </div>
                {(books ?? []).filter((b) => !b.archived).length > 0 && confirmDel !== s.id && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(books ?? [])
                      .filter((b) => !b.archived)
                      .map((b) => {
                        const on = b.sampleSources?.includes(s.id) ?? false
                        return (
                          <button
                            key={b.id}
                            type="button"
                            disabled={busy === s.id + b.id}
                            className={
                              on
                                ? 'rounded-full bg-orange-600 px-2.5 py-1 text-[11px] text-white disabled:opacity-50'
                                : 'rounded-full border border-orange-200 px-2.5 py-1 text-[11px] text-stone-500 disabled:opacity-50'
                            }
                            onClick={() =>
                              doToggle(
                                b.id,
                                s.id,
                                on ? (b.sampleSources ?? []).filter((x) => x !== s.id) : [...(b.sampleSources ?? []), s.id]
                              )
                            }
                          >
                            {on ? '✓ ' : ''}
                            {b.title}
                          </button>
                        )
                      })}
                  </div>
                )}
                {confirmDel === s.id ? (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="flex-1 text-[11px] text-red-600">删除范文？绑定的书会自动解绑</span>
                    <button
                      type="button"
                      disabled={busy === s.id}
                      className="rounded-lg bg-red-100 px-2.5 py-1 text-[11px] text-red-600"
                      onClick={() => doDelete(s.id)}
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-orange-200 px-2.5 py-1 text-[11px] text-stone-500"
                      onClick={() => setConfirmDel(null)}
                    >
                      取消
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="text-xs text-stone-400">还没有范文</div>
      )}

      <div className="mt-4 border-t border-orange-100 pt-3">
        <div className="mb-2 text-[11px] text-stone-400">
          电脑端把 txt 放进数据目录的 imports 文件夹，这里点导入（全文入库，agent 按需翻阅）
        </div>
        {files && files.length > 0 ? (
          <div className="space-y-2">
            {files.map((f) => (
              <div key={f.fileName} className="flex items-center justify-between rounded-xl bg-orange-50 p-2.5">
                <div className="min-w-0">
                  <div className="truncate text-xs text-stone-700">{f.fileName}</div>
                  <div className="text-[11px] text-stone-400">{f.chars.toLocaleString()} 字</div>
                </div>
                <button
                  type="button"
                  disabled={busy === f.fileName}
                  className="shrink-0 rounded-lg bg-orange-600 px-3 py-1.5 text-[11px] text-white disabled:opacity-50"
                  onClick={() => doImport(f.fileName)}
                >
                  {busy === f.fileName ? '导入中…' : '导入'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-stone-400">（imports 目录暂无 txt 文件）</div>
        )}
      </div>

      {msg && <div className="mt-2 text-xs text-orange-600">{msg}</div>}

      {reading && (
        <SampleReader
          sample={{ id: reading.id, name: reading.name, chars: reading.chars }}
          onClose={() => setReading(null)}
        />
      )}
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
  const { data: view } = useQuery({
    queryKey: ['settings'],
    queryFn: async (): Promise<SettingsView> => window.api.settings.get()
  })
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const { data: probeResult, isFetching: probing, refetch } = useQuery({
    queryKey: ['models', view?.provider],
    enabled: !!view,
    queryFn: () => {
      if (!view) throw new Error('settings 未加载')
      return window.api.models.probe({ provider: view.provider })
    },
    staleTime: 60_000,
    retry: false
  })

  if (!view) return <div className="py-4 text-center text-xs text-stone-400">加载中…</div>

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
              await window.api.settings.save({ provider: p })
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
            填好 API Key{view.provider === 'custom' ? '与 API 地址' : ''}后点「刷新列表」自动获取可选模型
          </div>
        )}
        {probeResult && modelList.length > 0 && (
          <div className="mt-1.5 text-[11px] text-stone-400">
            {probeResult.source === 'endpoint' ? '在线模型列表' : '内置清单（未连上端点，填 Key 后刷新验证）'}
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

function UpdateRow() {
  const [state, setState] = useState<'idle' | 'checking' | 'latest' | 'found' | 'downloading' | 'ready' | 'error'>(
    'idle'
  )
  const [note, setNote] = useState('')
  const [apkUrl, setApkUrl] = useState('')

  const check = async () => {
    setState('checking')
    const r = await checkUpdate()
    if (r.state === 'found') {
      setState('found')
      setApkUrl(r.url)
      setNote(`发现新版 ${r.version}`)
    } else if (r.state === 'latest') {
      setState('latest')
      setNote('已是最新版')
    } else {
      setState('error')
      setNote(r.error ?? '检查失败')
    }
  }

  const download = async () => {
    setState('downloading')
    const r = await downloadUpdate(apkUrl, (pct) => setNote(`下载中 ${pct}%`))
    if (r.state === 'ready') {
      setState('ready')
      setNote('下载完成，点击安装')
    } else if (r.state === 'error') {
      setState('error')
      setNote(r.error ?? '下载失败')
    }
  }

  const install = async () => {
    const r = await installUpdate()
    if (r.needsGrant) setNote('请先在系统里允许本应用安装未知应用，再回来点安装')
  }

  return (
    <div>
      {state === 'idle' || state === 'latest' || state === 'error' ? (
        <button
          type="button"
          className="w-full rounded-xl border border-orange-100 py-2.5 text-sm text-stone-600"
          onClick={check}
        >
          检查更新
        </button>
      ) : state === 'found' ? (
        <button
          type="button"
          className="w-full rounded-xl bg-orange-600 py-2.5 text-sm font-medium"
          onClick={download}
        >
          {note}
        </button>
      ) : state === 'downloading' ? (
        <button type="button" disabled className="w-full rounded-xl border border-orange-100 py-2.5 text-sm text-stone-500">
          {note}
        </button>
      ) : (
        <button
          type="button"
          className="w-full rounded-xl bg-orange-600 py-2.5 text-sm font-medium"
          onClick={install}
        >
          {note}
        </button>
      )}
      {state === 'error' && <div className="mt-2 text-xs text-red-600">{note}</div>}
    </div>
  )
}
