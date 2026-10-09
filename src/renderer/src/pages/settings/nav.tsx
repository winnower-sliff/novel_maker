import type { ReactNode } from 'react'

export type SectionId = 'service' | 'routing' | 'quota' | 'embedding' | 'server'

export interface SectionMeta {
  id: SectionId
  label: string
  desc: string
  icon: ReactNode
}

const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

export const SECTIONS: SectionMeta[] = [
  {
    id: 'service',
    label: '模型服务',
    desc: 'Provider 选择与 API 配置',
    icon: (
      <svg {...iconProps} aria-hidden="true" className="h-4 w-4">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
      </svg>
    )
  },
  {
    id: 'routing',
    label: '模型路由',
    desc: '各环节使用的模型与通道',
    icon: (
      <svg {...iconProps} aria-hidden="true" className="h-4 w-4">
        <path d="m18 14 4 4-4 4" />
        <path d="m18 2 4 4-4 4" />
        <path d="M2 18h2a4 4 0 0 0 3.3-1.7l5.4-8.6A4 4 0 0 1 16 6h6" />
        <path d="M2 6h2a4 4 0 0 1 3.6 2.2" />
        <path d="M22 18h-6a4 4 0 0 1-3.3-1.8l-.4-.5" />
      </svg>
    )
  },
  {
    id: 'quota',
    label: '额度与缓存',
    desc: '请求限额与 prompt cache',
    icon: (
      <svg {...iconProps} aria-hidden="true" className="h-4 w-4">
        <path d="m12 14 4-4" />
        <path d="M3.34 19a10 10 0 1 1 17.32 0" />
      </svg>
    )
  },
  {
    id: 'embedding',
    label: '本地语义检索',
    desc: '嵌入模型与语义索引',
    icon: (
      <svg {...iconProps} aria-hidden="true" className="h-4 w-4">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    )
  },
  {
    id: 'server',
    label: '手机访问',
    desc: '内嵌服务器与连接',
    icon: (
      <svg {...iconProps} aria-hidden="true" className="h-4 w-4">
        <rect width="14" height="20" x="5" y="2" rx="2" />
        <path d="M12 18h.01" />
      </svg>
    )
  }
]

export function sectionDomId(id: SectionId): string {
  return `settings-section-${id}`
}

export function SectionHead({ meta, right }: { meta: SectionMeta; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950/60 text-amber-400">
        {meta.icon}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-zinc-100">{meta.label}</h2>
        <p className="truncate text-xs text-zinc-500">{meta.desc}</p>
      </div>
      {right}
    </div>
  )
}
