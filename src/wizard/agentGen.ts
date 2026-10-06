import type { RuleSectionView } from '@shared/types'
import { startPipeline } from './pipeline'

/** 节级/整段「AI 优化」：改写并返回纯正文（空输出抛错透传） */
export function generateInstructionRefine(opts: {
  projectId: string
  scope: 'global' | 'project'
  text: string
  title?: string
  tag?: string | null
  onDelta?: (t: string) => void
}): { done: Promise<string>; abort: () => void } {
  const { done, abort } = startPipeline(
    'instructionRefine',
    {
      projectId: opts.projectId,
      scope: opts.scope,
      text: opts.text,
      title: opts.title,
      tag: opts.tag ?? null
    },
    opts.onDelta
  )
  return {
    done: done.then((r) => {
      const text = (r.data as { text?: string } | undefined)?.text ?? ''
      if (!text.trim()) throw new Error('AI 未输出有效内容，请重试')
      return text
    }),
    abort
  }
}

export interface InstructionSuggestResult {
  text: string
  /** global 草稿的解析结果（主进程返回） */
  preamble?: string
  sections?: RuleSectionView[]
}

/** 「AI 建议」：读取项目设定产出规则草稿（global 附带解析好的分节结构） */
export function generateInstructionSuggest(opts: {
  projectId: string
  scope: 'global' | 'project'
  onDelta?: (t: string) => void
}): { done: Promise<InstructionSuggestResult>; abort: () => void } {
  const { done, abort } = startPipeline(
    'instructionSuggest',
    { projectId: opts.projectId, scope: opts.scope },
    opts.onDelta
  )
  return {
    done: done.then((r) => {
      const data = r.data as InstructionSuggestResult | undefined
      const text = data?.text ?? ''
      if (!text.trim()) throw new Error('AI 未输出有效草稿，请重试')
      if (opts.scope === 'global' && !data?.sections?.length) {
        throw new Error('AI 未输出有效分节草稿，请重试')
      }
      return data as InstructionSuggestResult
    }),
    abort
  }
}
