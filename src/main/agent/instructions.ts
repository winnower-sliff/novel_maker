import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AgentInstructionsView, RuleSectionView } from '../../shared/types'
import * as store from '../store'

export function globalAgentsPath(): string {
  return join(app.getPath('userData'), 'agents.md')
}

const GLOBAL_TEMPLATE = `# 智能体全局指令

本文件是跨项目的个人写作偏好（「我习惯怎么写」），会注入生成链路与智能体系统提示（位于项目指令之前）。

职责边界：技能模板负责「这类动作的通用工艺」，本文件只写技能里没有的个人偏好，不要重复技能已有的通用纪律（如「章末留钩子」这类工艺要求技能里已经写了）；只适用于某个项目的约束写到该项目的指令里。

优先级：项目指令 > 本文件 > 技能模板。冲突时以优先级高者为准。

分节约定：## 标题末尾方括号是注入标签——[core] 和不带标签的节每次任务都完整注入；其他标签只在对应任务时注入（界面「生成」按动作自动带上，智能体做对应任务前先调 get_writing_rules 工具读取相关节）。新建节不带标签即视为每次注入。

示例：

## 核心纪律 [core]

- 章节标题不超过 12 个字。
- 中文标点使用全角，引号用「」。

## 对话偏好 [dialogue]

- 对话占比保持在 40% 左右，避免大段独白。
`

export function readGlobalInstructions(): string {
  const path = globalAgentsPath()
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf-8')
}

export function writeGlobalInstructions(text: string): void {
  const path = globalAgentsPath()
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(path, text, 'utf-8')
}

export function readProjectInstructions(projectId: string): string {
  const p = store.listProjects().find((x) => x.id === projectId)
  return p?.agentInstructions ?? ''
}

export function writeProjectInstructions(projectId: string, text: string): void {
  store.updateProject(projectId, { agentInstructions: text })
}

/** 首次访问时给全局 agents.md 落一份模板，降低上手成本 */
export function ensureGlobalInstructions(): void {
  const path = globalAgentsPath()
  if (existsSync(path)) return
  writeGlobalInstructions(GLOBAL_TEMPLATE)
}

export function getInstructionsView(projectId: string): AgentInstructionsView {
  ensureGlobalInstructions()
  const raw = readGlobalInstructions()
  const { preamble, sections } = parseSectionsView(raw)
  const projectRaw = readProjectInstructions(projectId)
  const project = parseSectionsView(projectRaw)
  return {
    globalText: raw,
    projectText: projectRaw,
    globalPath: globalAgentsPath(),
    globalPreamble: preamble,
    globalSections: sections,
    projectPreamble: project.preamble,
    projectSections: project.sections
  }
}

// ── agents.md 分节解析：按任务标签按需注入 ──

export interface RuleSection {
  /** 节标题（已剥离 [tag]） */
  title: string
  /** 小写标签；null = 无标签（恒注入） */
  tag: string | null
  /** 完整节文（含 ## 标题行） */
  text: string
}

// ## 后必须非 #（排除 ### 等更深标题）；空格可省（兼容「##标题」中文手误）
const HEADING_RE = /^##(?!#)[ \t]*(.+?)[ \t]*$/
// 只认字母数字/连字符/下划线标签：中文括注（如「[核心]」）不当标签，该节退化为无标签=恒注入（宁多注入勿静默丢失）
const TAG_RE = /\[([a-zA-Z0-9_-]+)\][ \t]*$/

export function parseRuleSections(raw: string): { preamble: string; sections: RuleSection[] } {
  const sections: RuleSection[] = []
  const preamble: string[] = []
  let cur: RuleSection | null = null
  for (const line of raw.split(/\r?\n/)) {
    const m = HEADING_RE.exec(line)
    if (m) {
      if (cur) sections.push(cur)
      const tagMatch = TAG_RE.exec(m[1])
      const tag = tagMatch ? tagMatch[1].trim().toLowerCase() : null
      const title = (tagMatch ? m[1].slice(0, tagMatch.index) : m[1]).trim()
      cur = { title, tag, text: `## ${title}` }
    } else if (cur) {
      cur.text += `\n${line}`
    } else {
      preamble.push(line)
    }
  }
  if (cur) sections.push(cur)
  return { preamble: preamble.join('\n').trim(), sections }
}

/** 供结构化编辑器：分节视图（body 剥离 ## 标题行） */
export function parseSectionsView(raw: string): {
  preamble: string
  sections: RuleSectionView[]
} {
  const { preamble, sections } = parseRuleSections(raw)
  return {
    preamble,
    sections: sections.map((s) => ({
      title: s.title,
      tag: s.tag,
      body: s.text.replace(/^##[^\n]*\n?/, '').trim()
    }))
  }
}

/** 解析结果按 mtime+size 缓存：写盘后立即失效，兼顾「即改即生效」与逐段写作的重复解析 */
let sectionCache: {
  mtimeMs: number
  size: number
  parsed: { preamble: string; sections: RuleSection[] }
} | null = null

function parseCached(): { preamble: string; sections: RuleSection[] } {
  const raw = readGlobalInstructions()
  if (!raw.trim()) {
    sectionCache = null
    return { preamble: '', sections: [] }
  }
  let st: { mtimeMs: number; size: number } | null = null
  try {
    const s = statSync(globalAgentsPath())
    st = { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    st = null
  }
  if (st && sectionCache && sectionCache.mtimeMs === st.mtimeMs && sectionCache.size === st.size) {
    return sectionCache.parsed
  }
  const parsed = parseRuleSections(raw)
  sectionCache = st ? { mtimeMs: st.mtimeMs, size: st.size, parsed } : null
  return parsed
}

/** 取全局 agents.md 命中分节（旧版整段文本落入 preamble，行为与历史版本一致） */
function pickRules(tags: readonly string[]): string {
  const raw = readGlobalInstructions()
  if (!raw.trim()) return ''
  return filterRules(parseCached(), tags)
}

/** 项目指令与全局同构解析：纯文本（无 ## 分节）整体是 preamble，恒注入；分节按 tag 过滤 */
function pickProjectRules(projectId: string, tags: readonly string[]): string {
  const raw = readProjectInstructions(projectId)
  if (!raw.trim()) return ''
  return filterRules(parseRuleSections(raw), tags)
}

/** preamble 恒注入 + 无标签/[core]/命中标签的节，统一过滤规则（全局/项目共用） */
function filterRules(
  parsed: { preamble: string; sections: RuleSection[] },
  tags: readonly string[]
): string {
  const wanted = new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))
  const parts = [
    parsed.preamble,
    ...parsed.sections
      .filter((s) => s.tag === null || s.tag === 'core' || wanted.has(s.tag))
      .map((s) => s.text.trim())
  ].filter(Boolean)
  return parts.join('\n\n')
}

/** 核心节（文件头 + [core] + 无标签节）：agent 系统提示固定注入的部分（全局） */
export function coreWritingRules(): string {
  return pickRules([])
}

/** 项目指令的核心节（preamble + [core] + 无标签节）：agent 系统提示固定注入的部分 */
export function projectCoreRules(projectId: string): string {
  return pickProjectRules(projectId, [])
}

const GLOBAL_RULES_HEADER =
  '【用户全局写作规则（跨项目偏好；与技能模板冲突时以本节为准，与项目指令冲突时以项目为准）】'
const PROJECT_RULES_HEADER =
  '【本项目指令（最高优先级：与技能模板、全局写作规则冲突时以本节为准）】'

/** 全局+项目命中节拼装块（全局在前、项目在后，各带优先级 header）；两处都为空返回空串 */
export function writingRulesBlock(tags: readonly string[], projectId: string): string {
  const global = pickRules(tags)
  const project = pickProjectRules(projectId, tags)
  const parts: string[] = []
  if (global) parts.push(`${GLOBAL_RULES_HEADER}\n${global}`)
  if (project) parts.push(`${PROJECT_RULES_HEADER}\n${project}`)
  return parts.join('\n\n')
}

/** 取 tags 命中的分节块全文（全局+项目，含核心节），无内容返回空串；get_writing_rules 工具与 pipeline 共用 */
export function writingRulesFor(tags: readonly string[], projectId: string): string {
  return writingRulesBlock(tags, projectId)
}

/** 写正文任务的规则分节（chapterRunner 逐段写作与 chapter 管线共用） */
export const CHAPTER_RULE_TAGS = [
  'chapter',
  'prose',
  'dialogue',
  'hooks',
  'plot',
  'continuity',
  'character'
] as const

/** 把 tags 命中的分节块追加到 system 末尾（全局在前、项目在后，项目标最高优先级）；两处都为空时原样返回 */
export function appendWritingRules(
  system: string,
  tags: readonly string[],
  projectId: string
): string {
  const block = writingRulesBlock(tags, projectId)
  if (!block) return system
  return system ? `${system}\n\n${block}` : block
}
