import { useEffect, useState } from 'react'
import { PURPOSES, type ModelProbeResult, type ModelRouting, type SettingsView } from '@shared/types'
import { Badge, Button, Card, Input, Label } from '../components/ui'
import { purposeLabel } from '../lib/format'

export default function Settings() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [customModels, setCustomModels] = useState('')
  const [modelRouting, setModelRouting] = useState<ModelRouting>({})
  const [quota5h, setQuota5h] = useState('0')
  const [promptCache, setPromptCache] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(0)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<ModelProbeResult | null>(null)
  const [probeError, setProbeError] = useState('')

  useEffect(() => {
    void window.api.settings.get().then((s) => {
      setView(s)
      setBaseUrl(s.baseUrl)
      setDefaultModel(s.defaultModel)
      setCustomModels(s.customModels)
      setModelRouting(s.modelRouting)
      setQuota5h(String(s.quota5hPrompts))
      setPromptCache(s.promptCache)
    })
  }, [])

  const modelOptions = (() => {
    const ids = new Set<string>(['glm-5.3', 'glm-4.6', 'glm-4.5-air', 'glm-4.5'])
    if (probeResult) probeResult.models.forEach((m) => ids.add(m))
    customModels
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((m) => ids.add(m))
    if (defaultModel) ids.add(defaultModel)
    return [...ids]
  })()

  const save = (): void => {
    setSaving(true)
    const patch: Parameters<typeof window.api.settings.save>[0] = {
      baseUrl,
      defaultModel,
      customModels,
      modelRouting,
      quota5hPrompts: Math.max(0, parseInt(quota5h, 10) || 0),
      promptCache
    }
    if (apiKey.trim() !== '') patch.apiKey = apiKey.trim()
    void window.api.settings
      .save(patch)
      .then((s) => {
        setView(s)
        setApiKey('')
        setSavedAt(Date.now())
      })
      .finally(() => setSaving(false))
  }

  const testConnection = (): void => {
    setProbing(true)
    setProbeError('')
    setProbeResult(null)
    const override = apiKey.trim() !== '' ? apiKey.trim() : undefined
    void window.api.models
      .probe(override)
      .then(setProbeResult)
      .catch((err: unknown) => setProbeError((err as Error).message))
      .finally(() => setProbing(false))
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold text-zinc-100">设置</h1>

      <Card className="space-y-4 p-5">
        <div>
          <Label>API Key {view?.hasApiKey && <span className="text-zinc-500">（已配置：{view.apiKeyMasked}）</span>}</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={view?.hasApiKey ? '留空则不修改' : '填入 GLM Coding Plan 的 API Key'}
          />
          <div className="mt-1.5 text-xs text-zinc-600">
            密钥使用系统凭据库加密存储，仅保存在本机。获取：open.bigmodel.cn → API Keys
          </div>
        </div>
        <div>
          <Label>API Base URL（Anthropic 兼容）</Label>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>默认模型</Label>
            <Input value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} />
          </div>
          <div>
            <Label>自定义模型（逗号分隔，追加到下拉列表）</Label>
            <Input
              value={customModels}
              onChange={(e) => setCustomModels(e.target.value)}
              placeholder="glm-x-custom"
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
        <div className="grid grid-cols-3 gap-3">
          {PURPOSES.map((p) => (
            <div key={p}>
              <Label>{purposeLabel(p)}</Label>
              <Input
                list="model-options"
                value={modelRouting[p] ?? ''}
                placeholder={p === 'playground' ? defaultModel || 'glm-4.6' : '留空用默认模型'}
                onChange={(e) => setModelRouting((prev) => ({ ...prev, [p]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <div className="text-xs text-zinc-600">
          建议：摘要/检查用 glm-4.5-air 省 token，大纲/正文用 glm-5.3 保证质量。
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
            className="w-48"
          />
          <div className="mt-1.5 text-xs text-zinc-600">
            GLM Coding Plan 为订阅制，官方接口不透传剩余额度；此处按你的档位限额配置，应用按本地
            5 小时滚动窗口统计展示进度。准确额度以 open.bigmodel.cn 控制台为准。
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <input
            id="prompt-cache"
            type="checkbox"
            checked={promptCache}
            onChange={(e) => setPromptCache(e.target.checked)}
            className="h-4 w-4 cursor-pointer accent-amber-600"
          />
          <label htmlFor="prompt-cache" className="cursor-pointer text-sm text-zinc-300">
            对 system 指令启用 prompt caching
          </label>
        </div>
        <div className="text-xs text-zinc-600">
          开启后 system 块带 cache_control，重复注入设定/文风指令时命中缓存计价（用量明细中「缓存读」非零即生效）。
        </div>
      </Card>

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
                <span key={m} className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-300">
                  {m}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="text-xs text-zinc-600">
          探测 /v1/models 端点；若服务端未实现则回退到内置模型列表（glm-5.3 / glm-4.6 / glm-4.5-air /
          glm-4.5），可在上方添加自定义 model id。
        </div>
      </Card>
    </div>
  )
}
