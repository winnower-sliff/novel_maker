import { PROVIDER_IDS, type ProviderId, providerPreset } from '@shared/providers'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../lib/queries'
import { Select } from './ui'

interface Props {
  value: string
  onChange: (provider: ProviderId | undefined) => void
  className?: string
  title?: string
}

/** 写作时临时切换生成引擎（provider override）：空值走默认路由，选中则本次请求改走该 provider 的默认模型，不落库 */
export function EngineSelect({ value, onChange, className, title }: Props) {
  const { data: settings } = useQuery(queries.settings())
  const ready = PROVIDER_IDS.filter((id) => {
    const preset = providerPreset(id)
    if (preset.needsKey && !settings?.configuredProviders.includes(id)) return false
    // 未加载完设置时不拦截；加载后隐藏默认模型为空的引擎（选中会以空模型发起请求必然失败）
    if (!settings) return true
    return !!settings.profiles[id]?.defaultModel?.trim()
  })
  return (
    <Select
      value={value}
      onChange={(e) => onChange((e.target.value || undefined) as ProviderId | undefined)}
      className={className}
      title={title ?? '本次生成使用的引擎（临时，不保存）'}
    >
      <option value="">默认引擎</option>
      {ready.map((id) => (
        <option key={id} value={id}>
          {providerPreset(id).label}
        </option>
      ))}
    </Select>
  )
}
