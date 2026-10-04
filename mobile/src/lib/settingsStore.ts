import { create } from 'zustand'
import { loadJson, localKeys, removeJson, saveJson } from '@mobile/lib/persist'
import { applySystemBars } from '@mobile/lib/systemBars'

export type Appearance = 'dark' | 'light' | 'sepia'
export type Accent = 'amber' | 'emerald' | 'sky' | 'violet' | 'rose'

const KEY = 'nm_settings_v1'

const FONT_MIN = 12
const FONT_MAX = 28
const FONT_DEFAULT = 17

const SPEED_MIN = 30
const SPEED_MAX = 150
const SPEED_DEFAULT = 60
/** 自动滚动速度调节步长（px/秒），抽屉调速控件用 */
export const SPEED_STEP = 10

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

/** 书内 UI 位置，按书记忆 */
export interface BookUiPos {
  tab?: string
  sub?: string
}

interface SettingsData {
  appearance: Appearance
  accent: Accent
  /** 护眼快捷开关切回的外观 */
  preSepia: Appearance
  /** 阅读正文字号（px），设置页与阅读页共用 */
  font: number
  /** 自动滚动速度（px/秒） */
  autoScrollSpeed: number
  /** 连接页记忆的服务器地址 */
  lastBase: string
  /** 各书 tab/子页位置：pid → 位置 */
  bookUi: Record<string, BookUiPos>
  /** 各书阅读进度：pid → 最近阅读章节 id */
  readPos: Record<string, string>
}

const DEFAULTS: SettingsData = {
  // 默认护眼：冷启动首帧即护眼橙，新装用户也直接进护眼模式
  appearance: 'sepia',
  accent: 'amber',
  preSepia: 'dark',
  font: FONT_DEFAULT,
  autoScrollSpeed: SPEED_DEFAULT,
  lastBase: '',
  bookUi: {},
  readPos: {}
}

/** 把外观/主题色写到 <html> data 属性，驱动 styles.css 的色板变量重映射；系统栏同步跟随 */
function applyTheme(s: Pick<SettingsData, 'appearance' | 'accent'>): void {
  const el = document.documentElement
  el.dataset.appearance = s.appearance
  el.dataset.accent = s.accent
  applySystemBars(s.appearance)
}

interface SettingsState extends SettingsData {
  /** 水合完成：完成前同步读 store 会拿到默认值，App 用它做首帧门控 */
  ready: boolean
  setAppearance: (a: Appearance) => void
  setAccent: (c: Accent) => void
  /** 护眼快捷开关：切到护眼 / 切回之前的外观 */
  toggleSepia: () => void
  setFont: (v: number) => void
  setAutoScrollSpeed: (v: number) => void
  setLastBase: (base: string) => void
  setBookUi: (pid: string, ui: Partial<BookUiPos>) => void
  /** 记录阅读进度：翻章频繁，走防抖写 */
  setReadPos: (pid: string, chapterId: string) => void
  clearReadPos: (pid?: string) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  const pick = (s: SettingsData, patch: Partial<SettingsData>): SettingsData => ({
    appearance: patch.appearance ?? s.appearance,
    accent: patch.accent ?? s.accent,
    preSepia: patch.preSepia ?? s.preSepia,
    font: patch.font ?? s.font,
    autoScrollSpeed: patch.autoScrollSpeed ?? s.autoScrollSpeed,
    lastBase: patch.lastBase ?? s.lastBase,
    bookUi: patch.bookUi ?? s.bookUi,
    readPos: patch.readPos ?? s.readPos
  })

  const persist = (patch: Partial<SettingsData>): void => {
    set((s) => {
      const next = pick(s, patch)
      applyTheme(next)
      void saveJson(KEY, next)
      return next
    })
  }

  // 阅读进度写频率高（每次翻章），合并短窗口内的连续写；防抖期间 state 已更新不受影响
  let posTimer: ReturnType<typeof setTimeout> | null = null
  const persistDebounced = (patch: Partial<SettingsData>): void => {
    if (posTimer) clearTimeout(posTimer)
    posTimer = setTimeout(() => {
      posTimer = null
      void saveJson(KEY, pick(useSettingsStore.getState(), patch))
    }, 500)
  }

  return {
    ...DEFAULTS,
    ready: false,
    setAppearance: (appearance) =>
      persist({ appearance, preSepia: appearance === 'sepia' ? get().preSepia : appearance }),
    setAccent: (accent) => persist({ accent }),
    toggleSepia: () => {
      const s = get()
      if (s.appearance === 'sepia') persist({ appearance: s.preSepia })
      else persist({ appearance: 'sepia', preSepia: s.appearance })
    },
    setFont: (v) => persist({ font: Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(v))) }),
    setAutoScrollSpeed: (v) =>
      persist({
        autoScrollSpeed: Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(v / SPEED_STEP) * SPEED_STEP))
      }),
    setLastBase: (lastBase) => persist({ lastBase }),
    setBookUi: (pid, ui) => {
      const bookUi = get().bookUi
      persist({ bookUi: { ...bookUi, [pid]: { ...bookUi[pid], ...ui } } })
    },
    setReadPos: (pid, chapterId) => {
      const readPos = { ...get().readPos, [pid]: chapterId }
      set({ readPos })
      persistDebounced({ readPos })
    },
    clearReadPos: (pid) => {
      if (pid) {
        if (!(pid in get().readPos)) return
        const readPos = { ...get().readPos }
        delete readPos[pid]
        persist({ readPos })
      } else {
        persist({ readPos: {} })
      }
    }
  }
})

function clampFont(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULTS.font
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(v)))
}

function clampSpeed(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULTS.autoScrollSpeed
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(v / SPEED_STEP) * SPEED_STEP))
}

function cleanBookUi(v: unknown): Record<string, BookUiPos> {
  if (!v || typeof v !== 'object') return {}
  const out: Record<string, BookUiPos> = {}
  for (const [pid, ui] of Object.entries(v as Record<string, unknown>)) {
    if (!pid || !ui || typeof ui !== 'object') continue
    const u = ui as Record<string, unknown>
    const pos: BookUiPos = {}
    if (typeof u.tab === 'string') pos.tab = u.tab
    if (typeof u.sub === 'string') pos.sub = u.sub
    if (pos.tab || pos.sub) out[pid] = pos
  }
  return out
}

function cleanStrMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [pid, chapterId] of Object.entries(v as Record<string, unknown>)) {
    if (pid && typeof chapterId === 'string') out[pid] = chapterId
  }
  return out
}

// 老版本散落 localStorage 的设置迁入单 key；迁完删除旧 key
async function migrateLegacy(): Promise<SettingsData> {
  const next: SettingsData = { ...DEFAULTS, bookUi: {}, readPos: {} }
  const theme = await loadJson<Partial<SettingsData>>('nm_theme')
  if (theme) {
    if (isAppearance(theme.appearance)) next.appearance = theme.appearance
    if (isAccent(theme.accent)) next.accent = theme.accent
    if (isAppearance(theme.preSepia)) next.preSepia = theme.preSepia
  }
  const font = await loadJson<unknown>('nm-read-font')
  next.font = clampFont(typeof font === 'string' ? Number.parseInt(font, 10) : font)
  const lastBase = await loadJson<unknown>('nm_last_base')
  if (typeof lastBase === 'string') next.lastBase = lastBase
  const tabKeys = localKeys('nm-book-tab:')
  for (const k of tabKeys) {
    const pid = k.slice('nm-book-tab:'.length)
    const v = localStorage.getItem(k)
    if (pid && v) next.bookUi[pid] = { ...next.bookUi[pid], tab: v }
  }
  const subKeys = localKeys('nm-book-sub:')
  for (const k of subKeys) {
    const pid = k.slice('nm-book-sub:'.length)
    const v = localStorage.getItem(k)
    if (pid && v) next.bookUi[pid] = { ...next.bookUi[pid], sub: v }
  }
  const posKeys = localKeys('nm-read-pos:')
  for (const k of posKeys) {
    const pid = k.slice('nm-read-pos:'.length)
    const v = localStorage.getItem(k)
    if (pid && v) next.readPos[pid] = v
  }
  if (Object.keys(next.bookUi).length === 0) next.bookUi = DEFAULTS.bookUi
  if (Object.keys(next.readPos).length === 0) next.readPos = DEFAULTS.readPos
  void saveJson(KEY, next)
  for (const k of ['nm_theme', 'nm-read-font', 'nm_last_base', ...tabKeys, ...subKeys, ...posKeys]) {
    void removeJson(k)
  }
  return next
}

// 异步水合：默认值同步起步（首帧即有正确主题底色），完成后回填持久化值。
// App 对 ready 做门控，水合完成前不渲染业务 UI，故无「用户先改动被旧值覆盖」问题。
void (async () => {
  let next: SettingsData = DEFAULTS
  try {
    const saved = await loadJson<Partial<SettingsData>>(KEY)
    if (saved) {
      next = {
        appearance: isAppearance(saved.appearance) ? saved.appearance : DEFAULTS.appearance,
        accent: isAccent(saved.accent) ? saved.accent : DEFAULTS.accent,
        preSepia: isAppearance(saved.preSepia) ? saved.preSepia : DEFAULTS.preSepia,
        font: clampFont(saved.font),
        autoScrollSpeed: clampSpeed(saved.autoScrollSpeed),
        lastBase: typeof saved.lastBase === 'string' ? saved.lastBase : DEFAULTS.lastBase,
        bookUi: cleanBookUi(saved.bookUi),
        readPos: cleanStrMap(saved.readPos)
      }
    } else {
      next = await migrateLegacy()
    }
  } catch {
    next = DEFAULTS
  }
  applyTheme(next)
  useSettingsStore.setState({ ...next, ready: true })
})()
