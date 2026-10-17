import type { LoopCounters } from './compact'

/** 自动续跑预算：检测到疑似中途停摆时自动注入「继续」的次数上限，防失控烧钱 */
export const MAX_AUTO_CONTINUES = 2

/** 征询语特征：模型任务未完却停下等指示时的高频措辞 */
export const STOP_PHRASES = [
  /是否继续/,
  /是否需要我/,
  /请确认/,
  /请指示/,
  /等你?确认/,
  /等你?指示/,
  /等待.{0,6}(指示|确认|指令|批准)/,
  /需要我(继续|接着|往下)/,
  /要我(继续|接着|往下)/,
  /可以继续吗/,
  /还要继续吗/
]

/**
 * 疑似中途停摆判定：本 run 做过实际工作（有工具调用）且收尾文本呈现
 * 压缩后停顿或征询语特征。纯问答（无工具调用）不算，绝不打扰正常对话。
 */
export function looksLikePaused(text: string, toolUseCount: number, compacted: boolean): boolean {
  if (toolUseCount === 0) return false
  const t = text.trim()
  if (!t) return false
  if (compacted) return true
  if (/[?？]\s*$/.test(t)) return true
  return STOP_PHRASES.some((re) => re.test(t))
}

/** 自动续跑策略：无工具调用收尾时判定疑似停摆，返回注入文本或 null（真完成） */
export function createContinuePolicy(counters: LoopCounters): {
  onStop(text: string, toolUseCount: number, compacted: boolean): string | null
} {
  return {
    onStop(text, toolUseCount, compacted) {
      if (counters.autoContinues >= MAX_AUTO_CONTINUES) return null
      if (!looksLikePaused(text, toolUseCount, compacted)) return null
      counters.autoContinues++
      return [
        '（系统自动续跑）检测到你可能在中途停下。请直接继续调用工具完成任务，无需征询意见；',
        '若确已全部完成，直接输出最终总结后停止；若存在必须由用户决策的分叉，列出选项后停止。',
        ...(counters.autoContinues >= MAX_AUTO_CONTINUES
          ? [
              '注意：自动续跑机会已用完，若本轮结束任务仍未完成，请明确交代已完成什么、还剩什么、为何停止。'
            ]
          : [])
      ].join('')
    }
  }
}
