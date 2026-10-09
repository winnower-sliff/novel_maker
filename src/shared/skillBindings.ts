/**
 * 管线动作 → 技能文件名（stem）绑定。
 * settings.json 的 skillBindings 按键覆盖：缺键 = 用默认绑定；显式 [] = 该动作禁用技能；多名 = 依序拼接。
 */
export type PipelineAction =
  | 'outline'
  | 'worldbuild'
  | 'character'
  | 'state-sync'
  | 'chapter'
  | 'segment-plan'
  | 'summary'
  | 'polish'
  | 'continuity'
  | 'review'
  | 'expand'
  | 'volume-summary'

export const DEFAULT_SKILL_BINDINGS: Record<PipelineAction, string[]> = {
  outline: ['outline-architect'],
  worldbuild: ['worldbuilder'],
  character: ['character-smith'],
  'state-sync': ['state-syncer'],
  chapter: ['chapter-writer'],
  'segment-plan': ['segment-planner'],
  summary: ['summarizer'],
  polish: ['style-polisher'],
  continuity: ['continuity-checker'],
  review: ['chapter-reviewer'],
  expand: ['chapter-expander'],
  'volume-summary': ['volume-summarizer']
}

export type SkillBindings = Record<string, string[]>

/** 解析某动作生效的技能名列表：覆盖值缺省时回退默认绑定 */
export function resolveSkillNames(
  action: PipelineAction,
  overrides?: SkillBindings | null
): string[] {
  const v = overrides?.[action]
  const names = v !== undefined ? v : DEFAULT_SKILL_BINDINGS[action]
  // 只认技能文件名：防手改 settings.json 填 ../ 之类越出技能目录读取任意文件
  return names.filter((n) => !/[\\/]/.test(n))
}
