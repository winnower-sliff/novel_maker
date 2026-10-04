import { Button } from '@mobile/components/ui'
import { ACCENTS, APPEARANCES, useSettingsStore } from '@mobile/lib/settingsStore'

/** 外观三选（深色/浅色/护眼）+ 主题色圆点；设置页与阅读抽屉共用 */
export function AppearanceControls() {
  const appearance = useSettingsStore((s) => s.appearance)
  const accent = useSettingsStore((s) => s.accent)
  const setAppearance = useSettingsStore((s) => s.setAppearance)
  const setAccent = useSettingsStore((s) => s.setAccent)
  return (
    <>
      <div className="mt-2 grid grid-cols-3 gap-1.5 rounded-lg bg-black/30 p-1">
        {APPEARANCES.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setAppearance(a.id)}
            className={`cursor-pointer rounded-md px-2 py-1.5 text-xs transition-colors ${
              appearance === a.id ? 'bg-amber-600 font-medium text-white' : 'text-zinc-400 active:bg-zinc-800'
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        {ACCENTS.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-label={c.label}
            title={c.label}
            onClick={() => setAccent(c.id)}
            className={`h-7 w-7 cursor-pointer rounded-full border-2 transition-[border-color,transform] ${
              accent === c.id ? 'scale-110 border-zinc-100' : 'border-transparent'
            }`}
            style={{ background: c.color }}
          />
        ))}
      </div>
    </>
  )
}

/** 字号 A-/A+ 调节；设置页与阅读抽屉共用，阅读抽屉传 step=2 保持原顶栏步长 */
export function FontControls({ step = 1 }: { step?: number }) {
  const font = useSettingsStore((s) => s.font)
  const setFont = useSettingsStore((s) => s.setFont)
  return (
    <div className="mt-3 flex items-center gap-3">
      <Button variant="ghost" className="px-4 py-1.5 text-xs" onClick={() => setFont(font - step)}>
        A-
      </Button>
      <span className="w-12 text-center text-sm tabular-nums text-zinc-300">{font}px</span>
      <Button variant="ghost" className="px-4 py-1.5 text-xs" onClick={() => setFont(font + step)}>
        A+
      </Button>
    </div>
  )
}
