import type { ReactNode } from 'react'

/**
 * 底部弹层：遮罩是语义化的关闭按钮（键盘/读屏可达），点面板内部不会关闭。
 * 全项目弹层统一走这里——返回键关闭等横切行为只需在此接一次。
 */
export function BottomSheet({
  onClose,
  bodyClass = '',
  children
}: {
  onClose: () => void
  /** 面板附加类，如限高内部滚动 'max-h-[75vh] overflow-y-auto no-scrollbar' */
  bodyClass?: string
  children: ReactNode
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-end">
      <button
        type="button"
        aria-label="关闭"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        className={`relative w-full rounded-t-2xl border-t border-orange-100 bg-white p-5 pb-safe ${bodyClass}`}
      >
        {children}
      </div>
    </div>
  )
}
