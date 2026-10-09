import { PROVIDER_IDS, providerPreset } from '@shared/providers'
import { PURPOSES } from '@shared/types'
import { Card, Input, Label, Select } from '../../components/ui'
import { purposeLabel } from '../../lib/format'
import type { SettingsForm } from './form'
import { SECTIONS, SectionHead } from './nav'

export function ModelRoutingSection({
  form,
  modelOptions
}: {
  form: SettingsForm
  modelOptions: string[]
}) {
  const { provider, active, patchDraft } = form

  return (
    <div className="space-y-4">
      <SectionHead meta={SECTIONS[1]} />

      <Card className="space-y-3 p-5">
        <datalist id="model-options">
          {modelOptions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PURPOSES.map((p) => {
            const route = active.modelRouting[p]
            const routeModel = typeof route === 'string' ? route : (route?.model ?? '')
            const routeProvider = typeof route === 'string' ? '' : (route?.provider ?? '')
            return (
              <div
                key={p}
                className="grid grid-cols-12 items-end gap-2 rounded-lg border border-zinc-800/60 bg-zinc-950/40 p-3"
              >
                <div className="col-span-4">
                  <Label>{purposeLabel(p)}</Label>
                  <Select
                    value={routeProvider}
                    onChange={(e) => {
                      const prov = e.target.value
                      const value =
                        prov === ''
                          ? routeModel || undefined
                          : { provider: prov, model: routeModel }
                      patchDraft({
                        modelRouting: { ...active.modelRouting, [p]: value }
                      })
                    }}
                    className="w-full"
                    title="该环节走哪个通道"
                  >
                    <option value="">当前通道</option>
                    {PROVIDER_IDS.filter((id) => id !== provider).map((id) => (
                      <option key={id} value={id}>
                        {providerPreset(id).label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="col-span-8">
                  <Label>模型</Label>
                  <Input
                    list="model-options"
                    value={routeModel}
                    placeholder={
                      p === 'playground' ? active.defaultModel || '默认模型' : '留空用默认模型'
                    }
                    onChange={(e) => {
                      const model = e.target.value
                      const value =
                        routeProvider === ''
                          ? model || undefined
                          : { provider: routeProvider, model }
                      patchDraft({
                        modelRouting: { ...active.modelRouting, [p]: value }
                      })
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
        <div className="text-xs leading-5 text-zinc-500">
          {provider === 'glm'
            ? '建议：摘要/检查/评审用 glm-4.5-air 省 token，大纲/正文用 glm-5.3 保证质量。'
            : '路由按 Provider 分别保存，切换 Provider 后各自独立。'}
          配置了 Ollama 时，可把摘要/检查/评审/状态同步等记账类任务指到 Ollama 通道本地跑，省云端
          token。
        </div>
      </Card>
    </div>
  )
}
