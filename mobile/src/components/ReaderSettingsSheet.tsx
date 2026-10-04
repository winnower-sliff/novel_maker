import { useEffect } from 'react'
import { Button } from '@mobile/components/ui'
import { AppearanceControls, FontControls } from '@mobile/components/appearance'
import { SPEED_STEP, useSettingsStore } from '@mobile/lib/settingsStore'

/** 阅读页设置抽屉：外观/主题色/字号/自动滚速度即时生效；点遮罩/Esc/返回键关闭（返回键由 Read 层注册） */
export function ReaderSettingsSheet({ onClose }: { onClose: () => void }) {
  const speed = useSettingsStore((s) => s.autoScrollSpeed)
  const setSpeed = useSettingsStore((s) => s.setAutoScrollSpeed)
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
        <div className="mt-4 border-t border-zinc-800 pt-3 text-xs font-medium text-zinc-500">自动滚动速度</div>
        <div className="mt-3 flex items-center gap-3">
          <Button variant="ghost" className="px-4 py-1.5 text-xs" onClick={() => setSpeed(speed - SPEED_STEP)}>
            −
          </Button>
          <span className="w-16 text-center text-sm tabular-nums text-zinc-300">{speed} px/s</span>
          <Button variant="ghost" className="px-4 py-1.5 text-xs" onClick={() => setSpeed(speed + SPEED_STEP)}>
            ＋
          </Button>
        </div>
      </div>
    </div>
  )
}
