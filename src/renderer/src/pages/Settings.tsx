import { useEffect, useState } from 'react'
import {
  PURPOSES,
  type ModelProbeResult,
  type ProviderProfile,
  type SettingsView
} from '@shared/types'
import {
  PROVIDER_IDS,
  providerPreset,
  type ProviderId
} from '@shared/providers'
import { ServerPanel } from '../components/ServerPanel'
import { Badge, Button, Card, Input, Label } from '../components/ui'
import { purposeLabel } from '../lib/format'

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
  const [savedAt, setSavedAt] = useState(0)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<ModelProbeResult | null>(null)
  const [probeError, setProbeError] = useState('')

  useEffect(() => {
    void window.api.settings.get().then((s) => {
      setView(s)
      setProvider(s.provider)
      setDrafts(s.profiles)
      setQuota5h(String(s.quota5hPrompts))
    })
  }, [])

  const preset = providerPreset(provider)
  const active = drafts?.[provider] ?? EMPTY_PROFILE
  const keyConfigured = view?.configuredProviders.includes(provider) ?? false

  const patchDraft = (patch: Partial<ProviderProfile>): void => {
    setDrafts((prev) => {
      if (!prev) return prev
      return { ...prev, [provider]: { ...prev[provider], ...patch } }
    })
  }

  const switchProvider = (id: ProviderId): void => {
    if (id === provider) return
    setProvider(id)
    setApiKey('')
    setProbeResult(null)
    setProbeError('')
  }

  const resetPreset = (): void => {
    patchDraft({ baseUrl: preset.baseUrl, defaultModel: preset.defaultModel })
    setProbeResult(null)
    setProbeError('')
  }

  const modelOptions = (() => {
    const ids = new Set<string>(preset.builtinModels)
    if (probeResult) probeResult.models.forEach((m) => ids.add(m))
    active.customModels
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((m) => ids.add(m))
    if (active.defaultModel) ids.add(active.defaultModel)
    return [...ids]
  })()

  const save = (): void => {
    setSaving(true)
    const patch: Parameters<typeof window.api.settings.save>[0] = {
      provider,
      baseUrl: active.baseUrl,
      defaultModel: active.defaultModel,
      customModels: active.customModels,
      modelRouting: active.modelRouting,
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
        setSavedAt(Date.now())
      })
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
        baseUrl: active.baseUrl.trim() !== '' ? active.baseUrl.trim() : undefined
      })
      .then(setProbeResult)
      .catch((err: unknown) => setProbeError((err as Error).message))
      .finally(() => setProbing(false))
  }

  const probeHint =
    provider === 'ollama'
      ? '探测 /v1/models，失败回退 /api/tags（本地 Ollama 无需 Key）'
      : provider === 'deepseek'
        ? '探测 https://api.deepseek.com/models（OpenAI 兼容模型列表）；失败回退内置列表'
        : '探测 /v1/models 端点；若服务端未实现则回退到内置模型列表'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-3 md:p-6">
        <h1 className="text-lg font-semibold text-zinc-100">设置</h1>

        <Card className="space-y-3 p-5">
          <div className="text-sm font-medium text-zinc-200">模型服务（Provider）</div>
          <div className="flex flex-wrap gap-2">
            {PROVIDER_IDS.map((id) => {
              const p = providerPreset(id)
              const configured = view?.configuredProviders.includes(id) ?? false
              return (
                <Button
                  key={id}
                  variant={id === provider ? 'primary' : 'ghost'}
                  onClick={() => switchProvider(id)}
                >
                  {p.label}
                  {configured && id !== provider && (
                    <span className="ml-1.5 text-emerald-400">·</span>
                  )}
                </Button>
              )
            })}
          </div>
          <div className="text-xs text-zinc-600">{preset.hint}</div>
        </Card>

        <Card className="space-y-4 p-5">
          <div>
            <Label>
              API Key{' '}
              {keyConfigured && (
                <span className="text-zinc-500">
                  （已配置{view?.provider === provider && view.apiKeyMasked ? `：${view.apiKeyMasked}` : ''}）
                </span>
              )}
            </Label>
            <Input
              type="password"
              value={apiKey}
              disabled={provider === 'ollama'}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                provider === 'ollama'
                  ? preset.keyHint
                  : keyConfigured
                    ? '留空则不修改'
                    : preset.keyHint
              }
            />
            <div className="mt-1.5 text-xs text-zinc-600">
              密钥使用系统凭据库加密存储，仅保存在本机，且各 Provider 分别保存。
            </div>
          </div>
          <div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label>API Base URL（Anthropic 兼容）</Label>
                <Input
                  value={active.baseUrl}
                  onChange={(e) => patchDraft({ baseUrl: e.target.value })}
                  placeholder={preset.baseUrl || 'https://example.com/anthropic'}
                />
              </div>
              <Button variant="ghost" onClick={resetPreset}>
                恢复预设
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label>默认模型</Label>
              <Input
                value={active.defaultModel}
                onChange={(e) => patchDraft({ defaultModel: e.target.value })}
                placeholder={preset.defaultModel || 'model-id'}
              />
            </div>
            <div>
              <Label>自定义模型（逗号分隔，追加到下拉列表）</Label>
              <Input
                value={active.customModels}
                onChange={(e) => patchDraft({ customModels: e.target.value })}
                placeholder="model-id"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
            {savedAt > 0 && <span className="text-xs text-emerald-400">已保存</span>}
          </div>
        </Card>

        <Card className="space-y-3 p-5">
          <div className="text-sm font-medium text-zinc-200">模型路由（各环节使用的模型）</div>
          <datalist id="model-options">
            {modelOptions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {PURPOSES.map((p) => (
              <div key={p}>
                <Label>{purposeLabel(p)}</Label>
                <Input
                  list="model-options"
                  value={active.modelRouting[p] ?? ''}
                  placeholder={p === 'playground' ? active.defaultModel || '默认模型' : '留空用默认模型'}
                  onChange={(e) =>
                    patchDraft({ modelRouting: { ...active.modelRouting, [p]: e.target.value } })
                  }
                />
              </div>
            ))}
          </div>
          <div className="text-xs text-zinc-600">
            {provider === 'glm'
              ? '建议：摘要/检查用 glm-4.5-air 省 token，大纲/正文用 glm-5.3 保证质量。'
              : '路由按 Provider 分别保存，切换 Provider 后各自独立。'}
          </div>
        </Card>

        <Card className="space-y-4 p-5">
          <div className="text-sm font-medium text-zinc-200">额度与缓存</div>
          <div>
            <Label>每 5 小时请求上限（0 = 不显示进度条）</Label>
            <Input
              type="number"
              min={0}
              value={quota5h}
              onChange={(e) => setQuota5h(e.target.value)}
              className="w-full sm:w-48"
            />
            <div className="mt-1.5 text-xs text-zinc-600">
              {provider === 'glm'
                ? 'GLM Coding Plan 为订阅制，官方接口不透传剩余额度；此处按你的档位限额配置，应用按本地 5 小时滚动窗口统计展示进度。准确额度以 open.bigmodel.cn 控制台为准。'
                : '按量计费的服务不透传剩余额度；此处仅按本地 5 小时滚动窗口统计请求数。'}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <input
              id="prompt-cache"
              type="checkbox"
              checked={preset.supportsCache && active.promptCache}
              disabled={!preset.supportsCache}
              onChange={(e) => patchDraft({ promptCache: e.target.checked })}
              className="h-4 w-4 cursor-pointer accent-amber-600 disabled:cursor-not-allowed"
            />
            <label htmlFor="prompt-cache" className="cursor-pointer text-sm text-zinc-300">
              对 system 指令启用 prompt caching
            </label>
          </div>
          <div className="text-xs text-zinc-600">
            {preset.supportsCache
              ? '开启后 system 块带 cache_control，重复注入设定/文风指令时命中缓存计价（用量明细中「缓存读」非零即生效）。'
              : `${preset.label} 不支持 cache_control，缓存自动关闭。`}
          </div>
        </Card>

        <ServerPanel />

        <Card className="space-y-3 p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-zinc-200">连接测试</div>
            <Button variant="ghost" onClick={testConnection} disabled={probing}>
              {probing ? '测试中…' : '探测可用模型'}
            </Button>
          </div>
          {probeError && <div className="text-sm text-red-400">{probeError}</div>}
          {probeResult && (
            <div className="space-y-2">
              <Badge tone={probeResult.source === 'endpoint' ? 'green' : 'amber'}>
                {probeResult.source === 'endpoint' ? '端点返回模型列表' : '端点不支持，使用内置列表'}
              </Badge>
              <div className="flex flex-wrap gap-1.5">
                {probeResult.models.map((m) => (
                  <span
                    key={m}
                    className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-300"
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="text-xs text-zinc-600">
            {probeHint}；可在上方添加自定义 model id。本地模型需先 `ollama pull`。
          </div>
        </Card>
      </div>
    </div>
  )
}
