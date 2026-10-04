import { create } from 'zustand'
import { loadJson, saveJson } from '@mobile/lib/persist'

export type Appearance = 'dark' | 'light' | 'sepia'
export type Accent = 'amber' | 'emerald' | 'sky' | 'violet' | 'rose'

const KEY = 'nm_theme'

/** 主题色色板（color 为色板代表色，用于设置页圆点，固定本色不随外观变） */
export const ACCENTS: Array<{ id: Accent; label: string; color: string }> = [
  { id: 'amber', label: '琥珀', color: '#d97706' },
  { id: 'emerald', label: '青绿', color: '#059669' },
  { id: 'sky', label: '天蓝', color: '#0284c7' },
  { id: 'violet', label: '紫罗兰', color: '#7c3aed' },
  { id: 'rose', label: '玫红', color: '#e11d48' }
]

export const APPEARANCES: Array<{ id: Appearance; label: string }> = [
  { id: 'dark', label: '深色' },
  { id: 'light', label: '浅色' },
  { id: 'sepia', label: '护眼' }
]

const isAppearance = (v: unknown): v is Appearance =>
  v === 'dark' || v === 'light' || v === 'sepia'
const isAccent = (v: unknown): v is Accent =>
  v === 'amber' || v === 'emerald' || v === 'sky' || v === 'violet' || v === 'rose'

interface Saved {
  appearance: Appearance
  accent: Accent
  preSepia: Appearance
}

/** 把外观/主题色写到 <html> data 属性，驱动 styles.css 的色板变量重映射 */
function apply(s: Saved): void {
  const el = document.documentElement
  el.dataset.appearance = s.appearance
  el.dataset.accent = s.accent
}

interface ThemeState extends Saved {
  setAppearance: (a: Appearance) => void
  setAccent: (c: Accent) => void
  /** 护眼快捷开关：切到护眼 / 切回之前的外观 */
  toggleSepia: () => void
}

export const useThemeStore = create<ThemeState>((set) => {
  const initial: Saved = { appearance: 'dark', accent: 'amber', preSepia: 'dark' }
  apply(initial)

  const persist = (s: Saved): void => {
    apply(s)
    void saveJson(KEY, s)
  }

  return {
    ...initial,
    setAppearance: (appearance) =>
      set((s) => {
        const next: Saved = {
          appearance,
          accent: s.accent,
          preSepia: appearance === 'sepia' ? s.preSepia : appearance
        }
        persist(next)
        return next
      }),
    setAccent: (accent) =>
      set((s) => {
        const next: Saved = { appearance: s.appearance, accent, preSepia: s.preSepia }
        persist(next)
        return next
      }),
    toggleSepia: () =>
      set((s) => {
        const appearance = s.appearance === 'sepia' ? s.preSepia : 'sepia'
        const next: Saved = {
          appearance,
          accent: s.accent,
          preSepia: appearance === 'sepia' ? s.appearance : appearance
        }
        persist(next)
        return next
      })
  }
})

// 异步水合：Preferences/localStorage 读回持久化外观（覆盖 WebView localStorage 丢失问题）。
// 用户在水合完成前已手动改动（dirty）则不回填，避免旧值覆盖新选择。
let dirty = false
const unsubDirty = useThemeStore.subscribe(() => {
  dirty = true
})

void (async () => {
  const raw = await loadJson<Partial<Saved>>(KEY)
  const next: Saved = {
    appearance: isAppearance(raw?.appearance) ? raw.appearance : 'dark',
    accent: isAccent(raw?.accent) ? raw.accent : 'amber',
    preSepia: isAppearance(raw?.preSepia) ? raw.preSepia : 'dark'
  }
  if (!dirty) {
    apply(next)
    useThemeStore.setState(next)
  }
  unsubDirty()
})()
