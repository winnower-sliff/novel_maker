import type { ChatMessageRow } from '@shared/types'

/** 开书引导的一轮对话：导演引导语 / 作者的话 */
export interface OnboardTurn {
  role: 'director' | 'author'
  text: string
}

export interface OnboardProgress {
  turns: OnboardTurn[]
  /** 导演留给他选的选项（确认词也在里面） */
  options: string[]
  stage: string
  /** 引导已走到最后一步（书名已定，书立起来了） */
  done: boolean
}

/** 书架批量查「哪些书还在开书中」的缓存键前缀 */
export const ONBOARD_PROGRESS_KEY = ['onboardProgress'] as const

/** 书架批量查「哪些书还在开书中」的缓存键 */
export const onboardProgressKey = (bookIds: string[]): readonly [string, string] => [
  ...ONBOARD_PROGRESS_KEY,
  bookIds.join(',')
]

const isGuideTurn = (m: ChatMessageRow): boolean =>
  m.role === 'assistant' && m.meta.onboard === true

/**
 * 从书的对话记录里读出开书引导走到哪了（对话记录是唯一事实源，中途退出后据此接着聊）。
 * 判据与服务端 onboard:answer 一致：最后一条导演引导消息决定当前阶段与选项。
 * 这本书还没开始过引导时返回 null。
 */
export function readOnboardProgress(msgs: ChatMessageRow[]): OnboardProgress | null {
  let first = -1
  let last = -1
  for (const [i, m] of msgs.entries()) {
    if (!isGuideTurn(m)) continue
    if (first < 0) first = i
    last = i
  }
  if (first < 0) return null

  const turns: OnboardTurn[] = []
  for (const m of msgs.slice(first, last + 1)) {
    if (isGuideTurn(m)) {
      turns.push({ role: 'director', text: m.content })
    } else if (m.role === 'user' && !m.meta.kind) {
      // 引导里的作者发言不带 kind；带 kind 的是后来在写作页聊的，不算引导对话
      turns.push({ role: 'author', text: m.content })
    }
  }
  const meta = msgs[last]?.meta ?? {}
  const stage = typeof meta.stage === 'string' ? meta.stage : 'premise'
  return {
    turns,
    options: Array.isArray(meta.options)
      ? meta.options.filter((o): o is string => typeof o === 'string')
      : [],
    stage,
    done: stage === 'done'
  }
}
