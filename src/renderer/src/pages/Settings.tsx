import { useEffect, useState } from 'react'
import type { ModelProbeResult, SettingsView } from '@shared/types'
import { Badge, Button, Card, Input, Label } from '../components/ui'

export default function Settings() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [customModels, setCustomModels] = useState('')
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
    })
  }, [])

  const save = (): void => {
    setSaving(true)
    const patch: Parameters<typeof window.api.settings.save>[0] = {
      baseUrl,
      defaultModel,
      customModels
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
