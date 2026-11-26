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

const NOT_CONNECTED = '还没连上电脑端，请先在设置里连接'
const PC_UNREACHABLE = '连不上电脑端，请确认电脑端开着、服务在运行'
const PC_TIMEOUT = '等太久没有回应，请检查与电脑的连接后重试'
/** 兜底展示原文时的长度上限（字符） */
const RAW_MAX = 160

// 模型 / 服务端错误的特征：与主进程 callJson.ts 的 QUOTA_RE、shouldRetry 认的字样对齐，
// 另收各平台的常见文案（密钥 / 欠费 / 限流 / 模型不存在 / 响应慢 / 电脑端连不上模型）
const KEY_RE =
  /\b401\b|api[ _-]?key\b|authenticat|unauthori[sz]ed|authori[sz]ation|密钥|认证失败|鉴权失败/i
const QUOTA_RE =
  /\b402\b|insufficient[_ -]?(?:balance|quota|credit|fund|user)|\bquota\b|\bbalance\b|arrear|欠费|余额|额度/i
const RATE_RE = /\b429\b|rate[ _-]?limit|too many requests|频率超限|并发超限|并发数过高|请求过多/i
const NO_MODEL_RE = /\b404\b|not exist|does not exist|not found|模型不存在/i
const SLOW_RE = /超时|timeout|timed out|中断|没有收到新数据/i
const NET_RE =
  /网络请求失败|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|getaddrinfo|socket|terminated|other side closed/i

/** 取 JSON 错误体里给人看的说明：{"error":{"message":"…"}} / {"error":"…"} / {"message":"…"} */
function jsonMessage(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  for (const key of ['error', 'message', 'msg', 'detail']) {
    const m = jsonMessage(o[key])
    if (m) return m
  }
  return null
}

/** 兜底展示原文：整段是 JSON 错误体时只留说明，压成一行，过长截断 */
function plain(raw: string): string {
  let s = raw
  const from = s.indexOf('{')
  if (from >= 0 && s.trimEnd().endsWith('}')) {
    try {
      const msg = jsonMessage(JSON.parse(s.slice(from)))
      if (msg) {
        const head = s.slice(0, from).trimEnd()
        s = head ? `${/[：:]$/.test(head) ? head : `${head}:`} ${msg}` : msg
      }
    } catch {
      /* 不是合法 JSON，原文展示 */
    }
  }
  const chars = Array.from(s.replace(/\s+/g, ' ').trim())
  return chars.length > RAW_MAX ? `${chars.slice(0, RAW_MAX - 1).join('')}…` : chars.join('')
}

/**
 * 把请求错误翻译成作者看得懂的一句话。连接类（手机 ↔ 电脑端）文案不变；
 * 模型 / 服务端类翻成「发生了什么 + 该怎么办」——模型错误到达手机时状态码多半已被
 * 网关的错误体替换（只剩文案），所以状态码和各平台的措辞都要认（见 callJson.ts / llmOpenai.ts）。
 */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  // 手机端自己的连接类措辞（bridge、导出 / APK 插件）先判
  if (/尚未连接服务器/.test(raw)) return NOT_CONNECTED
  if (/未连接服务器/.test(raw)) return PC_UNREACHABLE
  if (/请求超时/.test(raw)) return PC_TIMEOUT
  if (/无法连接服务器/.test(raw)) return PC_UNREACHABLE

  const isModel = /model|模型/i.test(raw)
  if (KEY_RE.test(raw)) return '模型密钥不对：到设置页检查模型和密钥'
  if (QUOTA_RE.test(raw)) return '模型额度用完了：到设置页换个模型或去充值'
  if (RATE_RE.test(raw)) return '模型那边太忙，稍等一下再试'
  if (isModel && NO_MODEL_RE.test(raw)) {
    return '模型名或 API 地址不对：到设置页检查模型设置'
  }
  if (SLOW_RE.test(raw)) return '等模型回应太久，已中断，可以重试'
  // 是电脑端连不上模型服务，不是手机连不上电脑端（那种上面已经返回了）
  if (isModel && NET_RE.test(raw)) {
    return '电脑端连不上模型服务：检查电脑端能不能上网，以及设置里的 API 地址'
  }
  // 其余：非 bridge 来源的连接类字样沿用旧规则，再不行就给原文
  // （提到模型 / model 的一律不是手机连电脑端的问题，不再往连接类上靠）
  if (!isModel && /无法连接|fetch|network|ECONN|网络/i.test(raw)) return PC_UNREACHABLE
  return plain(raw)
}

export function toastError(err: unknown, prefix = '操作失败') {
  useToastStore.getState().push(`${prefix}：${errorText(err)}`, 'error')
}
