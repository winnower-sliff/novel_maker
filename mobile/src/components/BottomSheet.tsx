import type { ReactNode } from 'react'
import { useBackHandler } from '../lib/backHandler'

/**
 * 底部弹层：遮罩是语义化的关闭按钮（键盘/读屏可达），点面板内部不会关闭。
 * 全项目弹层统一走这里——返回键关闭等横切行为只需在此接一次。
 * dark：从深色页面弹出时用（阅读页夜间主题），面板转深色底浅色字。
 */
export function BottomSheet({
  onClose,
  bodyClass = '',
  dark = false,
  children
}: {
  onClose: () => void
  /** 面板附加类，如限高内部滚动 'max-h-[75vh] overflow-y-auto no-scrollbar' */
  bodyClass?: string
  dark?: boolean
  children: ReactNode
}) {
  // 弹层是条件渲染：挂载即注册、卸载即注销，返回键只会关最上层的那一个
  useBackHandler(onClose)

  return (
    <div className="fixed inset-0 z-40 flex items-end">
      <button
        type="button"
        aria-label="关闭"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        className={`relative w-full rounded-t-2xl border-t p-5 pb-safe ${
          dark ? 'border-stone-700 bg-[#26221f] text-[#d6cfc4]' : 'border-orange-100 bg-white'
        } ${bodyClass}`}
      >
        {children}
      </div>
    </div>
  )
}
