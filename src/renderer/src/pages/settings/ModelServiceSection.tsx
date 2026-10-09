import { PROVIDER_IDS, providerPreset } from '@shared/providers'
import type { ModelProbeResult } from '@shared/types'
import { Badge, Button, Card, Input, Label, Select } from '../../components/ui'
import type { SettingsForm } from './form'
import { SECTIONS, SectionHead } from './nav'

export function ModelServiceSection({
  form,
  apiKey,
  onApiKeyChange,
  onSwitchProvider,
  onResetPreset,
  probing,
  probeResult,
  probeError,
  onProbe,
  onPickModel
}: {
  form: SettingsForm
  apiKey: string
  onApiKeyChange: (v: string) => void
  onSwitchProvider: (id: SettingsForm['provider']) => void
  onResetPreset: () => void
  probing: boolean
  probeResult: ModelProbeResult | null
  probeError: string
  onProbe: () => void
  onPickModel: (m: string) => void
}) {
  const { view, provider, preset, active, protocol, keyConfigured, patchDraft } = form

  const probeHint =
    protocol === 'openai'
      ? '探测 /v1/models（OpenAI 兼容模型列表）；失败回退内置列表'
      : provider === 'ollama'
        ? '探测 /v1/models，失败回退 /api/tags（本地 Ollama 无需 Key）'
        : provider === 'deepseek'
          ? '探测 https://api.deepseek.com/models（OpenAI 兼容模型列表）；失败回退内置列表'
          : '探测 /v1/models 端点；若服务端未实现则回退到内置模型列表'

  return (
    <div className="space-y-4">
      <SectionHead meta={SECTIONS[0]} />

      <Card className="space-y-3 p-5">
        <Label>选择模型服务</Label>
        <div className="flex flex-wrap gap-2">
          {PROVIDER_IDS.map((id) => {
            const p = providerPreset(id)
            const configured = view?.configuredProviders.includes(id) ?? false
            const selected = id === provider
            return (
              <button
                key={id}
                type="button"
                onClick={() => onSwitchProvider(id)}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 ${
                  selected
                    ? 'border-amber-600/70 bg-amber-950/40 text-amber-200'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                }`}
              >
                {p.label}
                {configured && (
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      selected ? 'bg-emerald-400' : 'bg-emerald-500/70'
                    }`}
                    title="已配置 API Key"
                  />
                )}
              </button>
            )
          })}
        </div>
        <div className="text-xs leading-5 text-zinc-500">{preset.hint}</div>
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <Label>
            API Key{' '}
            {keyConfigured && (
              <span className="text-zinc-500">
                （已配置
                {view?.provider === provider && view.apiKeyMasked ? `：${view.apiKeyMasked}` : ''}）
              </span>
            )}
          </Label>
          <Input
            type="password"
            value={apiKey}
            disabled={!preset.needsKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={
              !preset.needsKey ? preset.keyHint : keyConfigured ? '留空则不修改' : preset.keyHint
            }
          />
          <div className="mt-1.5 text-xs text-zinc-500">
            密钥使用系统凭据库加密存储，仅保存在本机，且各 Provider 分别保存。
          </div>
        </div>
        {provider === 'custom' && (
          <div className="max-w-xs">
            <Label>API 协议</Label>
            <Select
              value={protocol}
              onChange={(e) => patchDraft({ protocol: e.target.value as 'anthropic' | 'openai' })}
            >
              <option value="anthropic">Anthropic 兼容（/v1/messages）</option>
              <option value="openai">OpenAI 兼容（/v1/chat/completions）</option>
            </Select>
            <div className="mt-1.5 text-xs text-zinc-500">
              按网关实际支持的协议选择；OpenAI 兼容可接 LM Studio / llama.cpp / vLLM / one-api 等。
            </div>
          </div>
        )}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label>
              API Base URL（{protocol === 'openai' ? 'OpenAI 兼容' : 'Anthropic 兼容'}）
            </Label>
            <Input
              value={active.baseUrl}
              onChange={(e) => patchDraft({ baseUrl: e.target.value })}
              placeholder={
                preset.baseUrl ||
                (protocol === 'openai'
                  ? 'http://localhost:1234/v1'
                  : 'https://example.com/anthropic')
              }
            />
          </div>
          <Button variant="ghost" onClick={onResetPreset}>
            恢复预设
          </Button>
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
        <div>
          <Label>上下文窗口（tokens，可选）</Label>
          <Input
            inputMode="numeric"
            value={active.contextWindow ? String(active.contextWindow) : ''}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10)
              patchDraft({ contextWindow: Number.isFinite(n) && n > 0 ? n : undefined })
            }}
            placeholder={`留空用预设（${
              preset.contextWindow ? preset.contextWindow.toLocaleString() : '128,000'
            }）`}
          />
          <div className="mt-1.5 text-xs text-zinc-500">
            智能体据此预估主动压缩时机（用量达 80% 触发）；custom 端点或混用小窗模型时按实际填写
          </div>
        </div>
      </Card>

      <Card className="space-y-3 p-5">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-zinc-400">连接测试</div>
          <Button variant="ghost" onClick={onProbe} disabled={probing}>
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
              {probeResult.models.map((m) => {
                const isDefault = m === active.defaultModel
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => onPickModel(m)}
                    title={isDefault ? '当前默认模型' : '点击设为默认模型'}
                    className={`cursor-pointer rounded-md border px-2 py-0.5 font-mono text-xs transition-colors ${
                      isDefault
                        ? 'border-amber-600/70 bg-amber-950/40 text-amber-300'
                        : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                    }`}
                  >
                    {m}
                  </button>
                )
              })}
            </div>
            <div className="text-xs text-zinc-500">点击模型名可设为默认模型</div>
          </div>
        )}
        <div className="text-xs text-zinc-500">
          {probeHint}；可在上方添加自定义 model id。本地模型需先 `ollama pull`。
        </div>
      </Card>
    </div>
  )
}
