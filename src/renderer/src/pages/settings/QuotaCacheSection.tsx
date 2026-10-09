import { Card, Input, Label } from '../../components/ui'
import type { SettingsForm } from './form'
import { SECTIONS, SectionHead } from './nav'

export function QuotaCacheSection({
  form,
  quota5h,
  onQuotaChange
}: {
  form: SettingsForm
  quota5h: string
  onQuotaChange: (v: string) => void
}) {
  const { provider, preset, active, protocol, patchDraft } = form

  return (
    <div className="space-y-4">
      <SectionHead meta={SECTIONS[2]} />

      <Card className="space-y-4 p-5">
        <div>
          <Label>每 5 小时请求上限（0 = 不显示进度条）</Label>
          <Input
            type="number"
            min={0}
            value={quota5h}
            onChange={(e) => onQuotaChange(e.target.value)}
            className="w-full sm:w-48"
          />
          <div className="mt-1.5 text-xs leading-5 text-zinc-500">
            {provider === 'glm'
              ? 'GLM Coding Plan 为订阅制，官方接口不透传剩余额度；此处按你的档位限额配置，应用按本地 5 小时滚动窗口统计展示进度。准确额度以 open.bigmodel.cn 控制台为准。'
              : '按量计费的服务不透传剩余额度；此处仅按本地 5 小时滚动窗口统计请求数。'}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <input
            id="prompt-cache"
            type="checkbox"
            checked={preset.supportsCache && protocol !== 'openai' && active.promptCache}
            disabled={!preset.supportsCache || protocol === 'openai'}
            onChange={(e) => patchDraft({ promptCache: e.target.checked })}
            className="h-4 w-4 cursor-pointer accent-amber-600 disabled:cursor-not-allowed"
          />
          <label htmlFor="prompt-cache" className="cursor-pointer text-sm text-zinc-300">
            对 system 指令启用 prompt caching
          </label>
        </div>
        <div className="text-xs leading-5 text-zinc-500">
          {preset.supportsCache && protocol === 'openai'
            ? 'OpenAI 兼容协议不支持 cache_control，缓存自动关闭。'
            : preset.supportsCache
              ? '开启后 system 块带 cache_control，重复注入设定/文风指令时命中缓存计价（用量明细中「缓存读」非零即生效）。'
              : `${preset.label} 不支持 cache_control，缓存自动关闭。`}
        </div>
      </Card>
    </div>
  )
}
