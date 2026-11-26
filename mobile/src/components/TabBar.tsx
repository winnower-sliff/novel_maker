import { useUiStore } from '../lib/uiStore'
import { IconGear, IconLibrary, IconPencil } from './icons'

const TABS = [
  { key: 'shelf', label: '写书', icon: <IconPencil /> },
  { key: 'samples', label: '范文', icon: <IconLibrary /> },
  { key: 'settings', label: '设置', icon: <IconGear /> }
] as const

/**
 * 应用级底部导航：写书 / 范文 / 设置。
 * 由 App 在「没打开书」时渲染——书内工作区与开书引导是全屏层，各带自己的导航，这一条不出现。
 */
export function TabBar() {
  const tab = useUiStore((s) => s.tab)
  const setTab = useUiStore((s) => s.setTab)
  return (
    <nav
      aria-label="主导航"
      className="grid shrink-0 grid-cols-3 border-t border-orange-100 bg-white pb-safe"
    >
      {TABS.map((t) => {
        const on = tab === t.key
        return (
          <button
            key={t.key}
            type="button"
            aria-label={t.label}
            aria-current={on ? 'page' : undefined}
            className={`flex min-h-14 flex-col items-center justify-center gap-0.5 pb-1.5 pt-1 text-[11px] ${
              on ? 'font-medium text-orange-600' : 'text-stone-500'
            }`}
            onClick={() => setTab(t.key)}
          >
            <span
              className={`flex h-7 w-12 items-center justify-center rounded-full ${
                on ? 'bg-orange-100' : ''
              }`}
            >
              {t.icon}
            </span>
            {t.label}
          </button>
        )
      })}
    </nav>
  )
}
