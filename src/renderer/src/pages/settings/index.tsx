import { effectiveProtocol, type ProviderId, providerPreset } from '@shared/providers'
import type { ModelProbeResult, ProviderProfile, SettingsView } from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui'
import { qk, queries } from '../../lib/queries'
import { pushToast } from '../../lib/toastStore'
import { EmbeddingSection } from './EmbeddingSection'
import { type SettingsForm, stableStringify } from './form'
import { ModelRoutingSection } from './ModelRoutingSection'
import { ModelServiceSection } from './ModelServiceSection'
import { SECTIONS, type SectionId, sectionDomId } from './nav'
import { QuotaCacheSection } from './QuotaCacheSection'
import { ServerSection } from './ServerSection'

const EMPTY_PROFILE: ProviderProfile = {
  baseUrl: '',
  defaultModel: '',
  customModels: '',
  modelRouting: {},
  promptCache: false
}

export default function Settings() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [provider, setProvider] = useState<ProviderId>('glm')
  const [drafts, setDrafts] = useState<Record<ProviderId, ProviderProfile> | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [quota5h, setQuota5h] = useState('0')
  const [saving, setSaving] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<ModelProbeResult | null>(null)
  const [probeError, setProbeError] = useState('')
  const [activeSection, setActiveSection] = useState<SectionId>('service')

  const queryClient = useQueryClient()
  const { data: settingsData } = useQuery(queries.settings())
  const seededRef = useRef(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!settingsData || seededRef.current) return
    seededRef.current = true
    setView(settingsData)
    setProvider(settingsData.provider)
    setDrafts(settingsData.profiles)
    setQuota5h(String(settingsData.quota5hPrompts))
  }, [settingsData])

  const preset = providerPreset(provider)
  const savedProfile = view?.profiles[provider]
  const active: ProviderProfile = drafts?.[provider] ?? EMPTY_PROFILE
  const protocol = effectiveProtocol(provider, active.protocol)
  const keyConfigured = view?.configuredProviders.includes(provider) ?? false

  const patchDraft = (patch: Partial<ProviderProfile>): void => {
    setDrafts((prev) => {
      if (!prev) return prev
      return { ...prev, [provider]: { ...prev[provider], ...patch } }
    })
  }

  const profileFieldDiff =
    savedProfile !== undefined &&
    (active.baseUrl !== savedProfile.baseUrl ||
      active.defaultModel !== savedProfile.defaultModel ||
      active.customModels !== savedProfile.customModels ||
      active.contextWindow !== savedProfile.contextWindow ||
      active.protocol !== savedProfile.protocol)
  const serviceDirty = apiKey.trim() !== '' || profileFieldDiff || provider !== view?.provider
  const routingDirty =
    savedProfile !== undefined &&
    stableStringify(active.modelRouting) !== stableStringify(savedProfile.modelRouting)
  const quotaDirty =
    savedProfile !== undefined &&
    (quota5h !== String(view?.quota5hPrompts ?? 0) ||
      active.promptCache !== savedProfile.promptCache)
  const draftDirty = apiKey.trim() !== '' || profileFieldDiff || routingDirty || quotaDirty
  const dirtyMap: Record<SectionId, boolean> = {
    service: serviceDirty,
    routing: routingDirty,
    quota: quotaDirty,
    embedding: false,
    server: false
  }
  const dirtyCount = Object.values(dirtyMap).filter(Boolean).length

  const switchProvider = (id: ProviderId): void => {
    if (id === provider) return
    if (draftDirty) {
      pushToast('info', '当前有未保存的修改，已保留为草稿')
    }
    setProvider(id)
    setApiKey('')
    setProbeResult(null)
    setProbeError('')
  }

  const resetPreset = (): void => {
    patchDraft({
      baseUrl: preset.baseUrl,
      defaultModel: preset.defaultModel,
      contextWindow: undefined
    })
    setProbeResult(null)
    setProbeError('')
  }

  const modelOptions = (() => {
    const ids = new Set<string>(preset.builtinModels)
    if (probeResult)
      probeResult.models.forEach((m) => {
        ids.add(m)
      })
    active.customModels
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((m) => {
        ids.add(m)
      })
    if (active.defaultModel) ids.add(active.defaultModel)
    return [...ids]
  })()

  const save = (): void => {
    if (!drafts) return
    setSaving(true)
    const patch: Parameters<typeof window.api.settings.save>[0] = {
      provider,
      baseUrl: active.baseUrl,
      defaultModel: active.defaultModel,
      customModels: active.customModels,
      modelRouting: active.modelRouting,
      contextWindow: active.contextWindow ?? 0,
      protocol: provider === 'custom' ? protocol : undefined,
      quota5hPrompts: Math.max(0, parseInt(quota5h, 10) || 0),
      promptCache: active.promptCache
    }
    if (apiKey.trim() !== '') patch.apiKey = apiKey.trim()
    void window.api.settings
      .save(patch)
      .then((s) => {
        setView(s)
        setDrafts(s.profiles)
        setApiKey('')
        setQuota5h(String(Math.max(0, parseInt(quota5h, 10) || 0)))
        pushToast('success', '设置已保存')
        void queryClient.invalidateQueries({ queryKey: qk.settings })
      })
      .catch((err: unknown) => pushToast('error', `保存失败：${(err as Error).message}`))
      .finally(() => setSaving(false))
  }

  const testConnection = (): void => {
    setProbing(true)
    setProbeError('')
    setProbeResult(null)
    void window.api.models
      .probe({
        provider,
        apiKey: apiKey.trim() !== '' ? apiKey.trim() : undefined,
        baseUrl: active.baseUrl.trim() !== '' ? active.baseUrl.trim() : undefined,
        protocol
      })
      .then(setProbeResult)
      .catch((err: unknown) => setProbeError((err as Error).message))
      .finally(() => setProbing(false))
  }

  const pickModel = (m: string): void => {
    patchDraft({ defaultModel: m })
    pushToast('success', `默认模型已设为 ${m}（记得保存）`)
  }

  const jumpTo = (id: SectionId): void => {
    const el = scrollRef.current
    const target = document.getElementById(sectionDomId(id))
    if (!el || !target) return
    const barH = barRef.current?.offsetHeight ?? 0
    el.scrollTo({ top: target.offsetTop - barH - 12, behavior: 'smooth' })
  }

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const barH = barRef.current?.offsetHeight ?? 0
    const probe = el.scrollTop + barH + 48
    let current: SectionId = SECTIONS[0].id
    for (const s of SECTIONS) {
      const node = document.getElementById(sectionDomId(s.id))
      if (node && node.offsetTop <= probe) current = s.id
    }
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) {
      current = SECTIONS[SECTIONS.length - 1].id
    }
    setActiveSection(current)
  }

  const form: SettingsForm = {
    view,
    provider,
    active,
    preset,
    protocol,
    keyConfigured,
    patchDraft
  }

  const saveLabel = saving ? '保存中…' : dirtyCount > 0 ? `保存修改（${dirtyCount}）` : '全部已保存'

  return (
    <div className="flex h-full min-h-0">
      <nav className="hidden w-60 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950/40 md:flex">
        <div className="px-5 pb-3 pt-6">
          <h1 className="text-lg font-semibold text-zinc-100">设置</h1>
          <p className="mt-0.5 text-xs text-zinc-600">模型、路由与访问配置</p>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
          {SECTIONS.map((s) => {
            const isActive = s.id === activeSection
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => jumpTo(s.id)}
                className={`group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 ${
                  isActive
                    ? 'bg-zinc-800/80 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200'
                }`}
              >
                <span className={isActive ? 'text-amber-400' : 'text-zinc-500'}>{s.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm leading-5">{s.label}</span>
                  <span className="block truncate text-[11px] leading-4 text-zinc-600">
                    {s.desc}
                  </span>
                </span>
                {dirtyMap[s.id] && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                    title="有未保存的修改"
                  />
                )}
              </button>
            )
          })}
        </div>
        <div className="border-t border-zinc-800/80 p-3">
          <Button className="w-full" onClick={save} disabled={saving || dirtyCount === 0}>
            {saveLabel}
          </Button>
        </div>
      </nav>

      <div className="relative min-w-0 flex-1">
        <div ref={scrollRef} onScroll={handleScroll} className="relative h-full overflow-y-auto">
          <div
            ref={barRef}
            className="sticky top-0 z-20 flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/90 px-3 py-2 backdrop-blur md:hidden"
          >
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => jumpTo(s.id)}
                  className={`flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors ${
                    s.id === activeSection
                      ? 'border-amber-600/60 bg-amber-950/40 text-amber-200'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-400'
                  }`}
                >
                  {s.label}
                  {dirtyMap[s.id] && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
                </button>
              ))}
            </div>
            <Button
              className="shrink-0 px-2.5 py-1 text-xs"
              onClick={save}
              disabled={saving || dirtyCount === 0}
            >
              {saving ? '保存中…' : dirtyCount > 0 ? `保存 ${dirtyCount}` : '已保存'}
            </Button>
          </div>

          <div className="mx-auto max-w-3xl space-y-10 px-4 py-6 md:px-8">
            <div className="md:hidden">
              <h1 className="text-lg font-semibold text-zinc-100">设置</h1>
            </div>

            <section id={sectionDomId('service')}>
              <ModelServiceSection
                form={form}
                apiKey={apiKey}
                onApiKeyChange={setApiKey}
                onSwitchProvider={switchProvider}
                onResetPreset={resetPreset}
                probing={probing}
                probeResult={probeResult}
                probeError={probeError}
                onProbe={testConnection}
                onPickModel={pickModel}
              />
            </section>

            <section id={sectionDomId('routing')}>
              <ModelRoutingSection form={form} modelOptions={modelOptions} />
            </section>

            <section id={sectionDomId('quota')}>
              <QuotaCacheSection form={form} quota5h={quota5h} onQuotaChange={setQuota5h} />
            </section>

            <section id={sectionDomId('embedding')}>
              <EmbeddingSection />
            </section>

            <section id={sectionDomId('server')}>
              <ServerSection />
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
