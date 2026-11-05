import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { SettingsView, UsageStats } from '@shared/types'
import type { ProviderId } from '@shared/providers'
import { useConnStore } from '../lib/conn'
import { checkUpdate, downloadUpdate, installUpdate } from '../lib/apkUpdater'
import { useUiStore } from '../lib/uiStore'

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
          className="rounded-lg px-3 py-1.5 text-xs text-zinc-500"
          onClick={() => setTab('shelf')}
        >
          返回书架
        </button>
      </div>

      {/* 连接 */}
      <Section title="连接">
        <div className="flex items-center justify-between">
          <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">{conn?.baseUrl ?? '-'}</span>
          <span
            className={
              'ml-3 shrink-0 rounded-full px-2 py-0.5 text-[11px] ' +
              (server?.running ? 'bg-orange-900/60 text-orange-300' : 'bg-red-900/60 text-red-300')
            }
          >
            {server?.running ? '已连接' : '未连接'}
          </span>
        </div>
        {server && (
          <div className="mt-2 text-xs text-zinc-600">
            服务版本 {server.version} · 已运行 {Math.floor(server.uptimeS / 3600)}h
            {Math.floor((server.uptimeS % 3600) / 60)}m
          </div>
        )}
        <button
          type="button"
          className="mt-3 w-full rounded-xl border border-zinc-800 py-2.5 text-sm text-zinc-400"
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
                  <span key={g.key} className="rounded-full bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-400">
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
        <div className="mt-2 text-xs text-zinc-600">当前版本 {APP_VERSION}</div>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-3 text-xs font-semibold text-zinc-500">{title}</div>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-zinc-800/50 p-3">
      <div className="text-[11px] text-zinc-600">{label}</div>
      <div className="mt-0.5 text-sm text-zinc-200">{value}</div>
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
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  if (!view) return <div className="py-4 text-center text-xs text-zinc-600">加载中…</div>

  const profile = view.profiles[view.provider]
  const currentModel = model || profile.defaultModel
  const currentBase = baseUrl || profile.baseUrl

  const save = async () => {
    setBusy(true)
    setMsg('')
    try {
      await window.api.settings.save({
        provider: view.provider,
        profiles: {
          ...view.profiles,
          [view.provider]: { ...profile, baseUrl: currentBase, defaultModel: currentModel }
        },
        ...(apiKey.trim() ? { apiKeys: { [view.provider]: apiKey.trim() } } : {})
      })
      setApiKey('')
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      setMsg('已保存')
    } catch (e) {
      setMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const probe = async () => {
    setBusy(true)
    setMsg('')
    try {
      const r = await window.api.models.probe({ provider: view.provider })
      setMsg(r.source === 'endpoint' ? `在线探测到 ${r.models.length} 个模型` : '端点不可达，显示内置清单')
    } catch (e) {
      setMsg(`探测失败：${e instanceof Error ? e.message : String(e)}`)
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
              (view.provider === p ? 'bg-orange-600 text-white' : 'bg-zinc-800 text-zinc-400')
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
          <span className="mb-1 block text-[11px] text-zinc-600">API 地址（OpenAI 兼容）</span>
          <input
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm outline-none focus:border-orange-700"
            placeholder="https://…/v1"
            value={currentBase}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
      )}

      <label className="mb-3 block">
        <span className="mb-1 block text-[11px] text-zinc-600">
          API Key {view.apiKeyMasked ? `（已配置 ${view.apiKeyMasked}）` : '（未配置）'}
        </span>
        <input
          type="password"
          className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm outline-none focus:border-orange-700"
          placeholder="sk-…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>

      <label className="mb-4 block">
        <span className="mb-1 block text-[11px] text-zinc-600">模型名</span>
        <input
          className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm outline-none focus:border-orange-700"
          value={currentModel}
          onChange={(e) => setModel(e.target.value)}
        />
      </label>

      {msg && <div className="mb-3 text-xs text-orange-400">{msg}</div>}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          className="flex-1 rounded-xl bg-orange-600 py-2.5 text-sm font-medium disabled:opacity-50"
          onClick={save}
        >
          {busy ? '…' : '保存'}
        </button>
        <button
          type="button"
          disabled={busy}
          className="flex-1 rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-400 disabled:opacity-50"
          onClick={probe}
        >
          测试连接
        </button>
      </div>
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
          className="w-full rounded-xl border border-zinc-800 py-2.5 text-sm text-zinc-300"
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
        <button type="button" disabled className="w-full rounded-xl border border-zinc-800 py-2.5 text-sm text-zinc-500">
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
      {state === 'error' && <div className="mt-2 text-xs text-red-400">{note}</div>}
    </div>
  )
}
