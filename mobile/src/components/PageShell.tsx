import type { ReactNode } from 'react'

/**
 * 应用级页面（写书 / 范文 / 设置）的外壳：固定顶栏 + 内部滚动区。
 * 三个 tab 共用同一套顶栏高度，切换时标题不上下跳；页面是底部导航上方的 flex 项，
 * 滚动区在导航上方收口，内容不会被导航盖住，也就不需要手写「导航高度」的留白。
 */
export function PageShell({
  title,
  subtitle,
  action,
  bodyClass = '',
  children
}: {
  title: string
  /** 标题下的一行小字；没有就不占高度 */
  subtitle?: string
  /** 顶栏右侧的操作（如「＋ 开新书」） */
  action?: ReactNode
  /** 附加到滚动区上的类（如让空状态撑满居中的 flex flex-col） */
  bodyClass?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 px-5 pb-3 pt-safe">
        <div className="min-w-0 pt-3">
          <h1 className="text-2xl font-bold leading-tight">{title}</h1>
          {subtitle && <p className="mt-1 truncate text-xs text-stone-400">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className={`no-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-8 ${bodyClass}`}>
        {children}
      </div>
    </div>
  )
}
