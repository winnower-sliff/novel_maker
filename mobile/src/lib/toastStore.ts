import { create } from 'zustand'

type Tone = 'info' | 'error'

interface ToastItem {
  id: number
  text: string
  tone: Tone
}

interface ToastState {
  items: ToastItem[]
  push: (text: string, tone?: Tone) => void
  dismiss: (id: number) => void
}

let seq = 0
const timers = new Map<number, ReturnType<typeof setTimeout>>()

/** 全局轻提示：同一时刻最多 3 条，出错的多停一会儿 */
export const useToastStore = create<ToastState>((set, get) => ({
  items: [],
  push: (text, tone = 'info') => {
    const id = ++seq
    set({ items: [...get().items.slice(-2), { id, text, tone }] })
    timers.set(
      id,
      setTimeout(() => get().dismiss(id), tone === 'error' ? 5000 : 2800)
    )
  },
  dismiss: (id) => {
    const t = timers.get(id)
    if (t) clearTimeout(t)
    timers.delete(id)
    set({ items: get().items.filter((x) => x.id !== id) })
  }
}))

/** 把请求错误翻译成作者看得懂的一句话 */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  if (/尚未连接服务器/.test(raw)) return '还没连上电脑端，请先在设置里连接'
  if (/超时|timeout/i.test(raw)) return '等太久没有回应，请检查与电脑的连接后重试'
  if (/无法连接|fetch|network|ECONN|网络/i.test(raw)) {
    return '连不上电脑端，请确认电脑端开着、服务在运行'
  }
  return raw
}

export function toastError(err: unknown, prefix = '操作失败') {
  useToastStore.getState().push(`${prefix}：${errorText(err)}`, 'error')
}
