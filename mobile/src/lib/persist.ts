/**
 * 持久化层：APK 走 Capacitor Preferences（原生 SharedPreferences，绝对持久），
 * 解决 Android WebView localStorage 重启丢失的问题；浏览器/插件不可用降级 localStorage。
 * 双写（Preferences + localStorage 镜像）：读时 Preferences 优先，无值回退 localStorage
 * 并自动迁移，老版本数据无缝升级。
 */

type Json = unknown

interface PrefsPlugin {
  get: (o: { key: string }) => Promise<{ value: string | null }>
  set: (o: { key: string; value: string }) => Promise<void>
  remove: (o: { key: string }) => Promise<void>
}

/** 经 window.Capacitor 取原生 Preferences 插件（native 侧已装 @capacitor/preferences），浏览器返回 null */
function getPrefs(): Promise<PrefsPlugin | null> {
  const plugins = (
    window as unknown as { Capacitor?: { Plugins?: { Preferences?: PrefsPlugin } } }
  ).Capacitor?.Plugins
  return Promise.resolve(plugins?.Preferences ?? null)
}

export async function loadJson<T>(key: string): Promise<T | undefined> {
  try {
    const prefs = await getPrefs()
    if (prefs) {
      const { value } = await prefs.get({ key })
      if (value != null) return JSON.parse(value) as T
    }
  } catch {
    // Preferences 不可用/损坏：走 localStorage 回退
  }
  try {
    const raw = localStorage.getItem(key)
    if (raw != null) {
      const parsed = JSON.parse(raw) as T
      void saveJson(key, parsed)
      return parsed
    }
  } catch {
    // 无历史数据
  }
  return undefined
}

export async function saveJson(key: string, value: Json): Promise<void> {
  const raw = JSON.stringify(value)
  try {
    const prefs = await getPrefs()
    if (prefs) await prefs.set({ key, value: raw })
  } catch {
    // 静默：localStorage 镜像仍有一份
  }
  try {
    localStorage.setItem(key, raw)
  } catch {
    // 配额满等场景静默
  }
}

export async function removeJson(key: string): Promise<void> {
  try {
    const prefs = await getPrefs()
    if (prefs) await prefs.remove({ key })
  } catch {
    // 静默
  }
  try {
    localStorage.removeItem(key)
  } catch {
    // 静默
  }
}

/** 列出 localStorage 里带指定前缀的 key（老版本散落数据迁移用） */
export function localKeys(prefix: string): string[] {
  try {
    const out: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(prefix)) out.push(k)
    }
    return out
  } catch {
    return []
  }
}
