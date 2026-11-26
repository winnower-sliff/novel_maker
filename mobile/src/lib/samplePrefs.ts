import { create } from 'zustand'
import { loadJson, saveJson } from './persist'

/**
 * 范文阅读的本机记忆：每本范文上次读到的位置 + 所有范文共用的字号。
 * 走 persist 层（APK 里是原生 Preferences，重启不丢；浏览器降级 localStorage）。
 */

/** 某本范文上次读到的位置：与 sample:readText 的正文窗口一一对应 */
export interface SampleProgress {
  from: number
  len: number
  /** 窗口标题（章名 / 「全文 30%」/「开头」） */
  label: string
  /** 所在节的下标；不在任何一节里为 -1 */
  secIdx: number
}

export const FONT_MIN = 13
export const FONT_MAX = 26
export const FONT_DEFAULT = 16

interface Saved {
  fontSize?: number
  progress?: Record<string, SampleProgress>
}

interface SamplePrefsState {
  /** 阅读字号（px） */
  fontSize: number
  /** 键是范文 id */
  progress: Record<string, SampleProgress>
  setFontSize: (size: number) => void
  remember: (sampleId: string, p: SampleProgress) => void
  /** 范文删掉后顺手清掉它的进度 */
  forget: (sampleId: string) => void
}

const KEY = 'nm-sample-reader'

const clampFont = (n: number): number => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)))

/** 存下来的进度逐条验形状：坏了的条目丢掉，不让一条坏数据弄崩整个书架 */
function validProgress(raw: unknown): Record<string, SampleProgress> {
  const out: Record<string, SampleProgress> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, v] of Object.entries(raw as Record<string, Partial<SampleProgress>>)) {
    if (
      v &&
      typeof v.from === 'number' &&
      typeof v.len === 'number' &&
      typeof v.secIdx === 'number' &&
      typeof v.label === 'string'
    ) {
      out[id] = { from: v.from, len: v.len, label: v.label, secIdx: v.secIdx }
    }
  }
  return out
}

const write = (): void => {
  const { fontSize, progress } = useSamplePrefs.getState()
  void saveJson(KEY, { fontSize, progress })
}

export const useSamplePrefs = create<SamplePrefsState>((set) => ({
  fontSize: FONT_DEFAULT,
  progress: {},
  setFontSize: (size) => {
    set({ fontSize: clampFont(size) })
    write()
  },
  remember: (sampleId, p) => {
    set((s) => ({ progress: { ...s.progress, [sampleId]: p } }))
    write()
  },
  forget: (sampleId) => {
    set((s) => {
      const { [sampleId]: _dropped, ...rest } = s.progress
      return { progress: rest }
    })
    write()
  }
}))

// 异步水合：WebView 的 localStorage 可能丢，统一从 persist 层读回。
// 读回之前作者已经动过的以作者为准，不被旧值盖掉。
void (async () => {
  const saved = await loadJson<Saved>(KEY)
  if (!saved) return
  const cur = useSamplePrefs.getState()
  useSamplePrefs.setState({
    fontSize:
      cur.fontSize === FONT_DEFAULT && typeof saved.fontSize === 'number'
        ? clampFont(saved.fontSize)
        : cur.fontSize,
    progress: { ...validProgress(saved.progress), ...cur.progress }
  })
})()
