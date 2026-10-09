import type { ChatParams } from '../../shared/types'
import { getSkill, stripFrontmatter } from '../skills'
import * as store from '../store'

/**
 * refresh_volume_summary 工具专用（原管线函数收编，管线已拆）：
 * 卷摘要请求构建 + 结果落库。
 */
export function buildVolumeSummaryRequest(projectId: string, volume: number): ChatParams {
  const outlines = store
    .listOutlines(projectId)
    .filter((o) => o.volume === volume)
    .sort((a, b) => a.chapterNo - b.chapterNo)
  if (outlines.length === 0) throw new Error(`第 ${volume} 卷还没有大纲`)
  const withSummary = outlines.filter((o) => {
    const c = store.getChapterByOutline(o.id)
    return c && store.getSummary(c.id)
  })
  if (withSummary.length === 0) throw new Error(`第 ${volume} 卷还没有已定稿的章节摘要`)
  const chapterLines = outlines
    .map((o) => {
      const c = store.getChapterByOutline(o.id)
      const s = c ? store.getSummary(c.id) : null
      if (s) {
        return `第${o.chapterNo}章《${o.title}》：${s.summary}${s.timeline ? `（时间线：${s.timeline}）` : ''}`
      }
      return `第${o.chapterNo}章《${o.title}》（未写/未定稿）：${o.synopsis.slice(0, 80)}`
    })
    .join('\n')
  const foreLines = store
    .listForeshadows(projectId)
    .filter((f) => f.status === 'open' && f.plantedChapter)
    .map((f) => `- ${f.content}（埋于${f.plantedChapter}）`)
    .join('\n')
  const stateLines = withSummary
    .flatMap((o) => {
      const c = store.getChapterByOutline(o.id)
      const s = c ? store.getSummary(c.id) : null
      return s ? s.characterStates : []
    })
    .filter((cs) => cs.name)
    .join('；')
  const skill = getSkill('volume-summarizer.md')
  const system = skill ? stripFrontmatter(skill.raw) : '你是小说项目助手，负责生成某一卷的卷摘要。'
  const user = [
    `请生成第 ${volume} 卷的卷摘要。`,
    `【各章摘要】\n${chapterLines}`,
    foreLines && `【当前未回收伏笔（参考）】\n${foreLines}`,
    stateLines && `【末章人物状态（参考）】${stateLines}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 2048,
    temperature: 0.3,
    purpose: 'summary'
  }
}

export function applyVolumeSummaryResult(
  projectId: string,
  volume: number,
  text: string
): { volume: number; summaryChars: number; parsed: boolean } {
  const summary = text.trim()
  if (!summary) return { volume, summaryChars: 0, parsed: false }
  store.saveVolumeSummary(projectId, volume, summary)
  return { volume, summaryChars: summary.length, parsed: true }
}
