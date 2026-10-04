import { useEffect } from 'react'
import { AppearanceControls, FontControls } from '@mobile/components/appearance'

/** 阅读页设置抽屉：外观/主题色/字号即时生效；点遮罩/Esc/返回键关闭（返回键由 Read 层注册） */
export function ReaderSettingsSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div role="dialog" aria-modal="true" aria-label="阅读设置" className="fixed inset-0 z-40 flex flex-col justify-end">
      <div aria-hidden="true" className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="text-sm font-medium text-zinc-200">阅读设置</div>
        <p className="mt-0.5 text-[11px] text-zinc-500">即时生效，与「设置」页同步</p>
        <div className="mt-2 text-xs font-medium text-zinc-500">外观</div>
        <AppearanceControls />
        <div className="mt-4 border-t border-zinc-800 pt-3 text-xs font-medium text-zinc-500">字号</div>
        <FontControls step={2} />
      </div>
    </div>
  )
}
