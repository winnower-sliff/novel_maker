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

/** 逆解析：结构化分节重组完整指令文本（分节级编辑写回用） */
export function serializeRuleSections(preamble: string, sections: readonly RuleSection[]): string {
  const parts: string[] = []
  if (preamble.trim()) parts.push(preamble.trim())
  for (const sec of sections) {
    const body = sec.text.split('\n').slice(1).join('\n').trim()
    const heading = `## ${sec.title}${sec.tag ? ` [${sec.tag}]` : ''}`
    parts.push(body ? `${heading}\n${body}` : heading)
  }
  return parts.join('\n\n')
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

// ── 分节原子编辑（agent 工具与 UI 通道共享同一实现）──

const INSTRUCTIONS_MAX_CHARS = 20000

export interface SectionEditInput {
  /** 节标题（不含 ## 前缀），大小写不敏感定位 */
  title: string
  /** 新内容；undefined=只改 tag；空串=删除该节 */
  body?: string
  /** undefined=不改 tag；'' 或 null=改为恒注入；否则小写化存储 */
  tag?: string | null
}

export interface SectionEditResult {
  action: 'created' | 'updated' | 'deleted'
  scope: 'global' | 'project'
  title: string
  tag: string | null
}

function normalizeTag(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  const t = raw.trim().toLowerCase()
  return t || null
}

/** 按节修改指令（scope 校验、20000 字上限都在此把关）；title 定位、body 三态、tag 可选改 */
export function applySectionEdit(
  scope: string,
  projectId: string,
  edit: SectionEditInput
): SectionEditResult {
  if (scope !== 'global' && scope !== 'project')
    throw new Error("scope 必须是 'global' 或 'project'")
  const title = edit.title.trim()
  if (!title) throw new Error('title 不能为空')
  const tag = normalizeTag(edit.tag)
  const body = edit.body
  const raw = scope === 'global' ? readGlobalInstructions() : readProjectInstructions(projectId)
  const { preamble, sections } = parseRuleSections(raw)
  const writeBack = (out: string): void => {
    if (out.length > INSTRUCTIONS_MAX_CHARS)
      throw new Error(`指令过长（上限 ${INSTRUCTIONS_MAX_CHARS} 字），请精简`)
    if (scope === 'global') writeGlobalInstructions(out)
    else writeProjectInstructions(projectId, out)
  }
  const idx = sections.findIndex((sec) => sec.title.toLowerCase() === title.toLowerCase())
  if (idx === -1) {
    if (!body?.trim()) throw new Error(`分节「${title}」不存在；内容为空无法新建（传内容即可新建）`)
    sections.push({ title, tag: tag ?? null, text: `## ${title}\n${body.trim()}` })
    writeBack(serializeRuleSections(preamble, sections))
    return { action: 'created', scope, title, tag: tag ?? null }
  }
  if (body !== undefined && !body.trim()) {
    sections.splice(idx, 1)
    writeBack(serializeRuleSections(preamble, sections))
    return { action: 'deleted', scope, title, tag: null }
  }
  if (body?.trim()) {
    sections[idx] = { ...sections[idx], text: `## ${sections[idx].title}\n${body.trim()}` }
  }
  if (tag !== undefined) sections[idx] = { ...sections[idx], tag }
  writeBack(serializeRuleSections(preamble, sections))
  return { action: 'updated', scope, title, tag: sections[idx].tag }
}

/** 只改指令开头段（preamble，每次任务恒注入）；分节原样保留 */
export function applyPreambleEdit(scope: string, projectId: string, text: string): void {
  if (scope !== 'global' && scope !== 'project')
    throw new Error("scope 必须是 'global' 或 'project'")
  const raw = scope === 'global' ? readGlobalInstructions() : readProjectInstructions(projectId)
  const { sections } = parseRuleSections(raw)
  const out = serializeRuleSections(text, sections)
  if (out.length > INSTRUCTIONS_MAX_CHARS)
    throw new Error(`指令过长（上限 ${INSTRUCTIONS_MAX_CHARS} 字），请精简`)
  if (scope === 'global') writeGlobalInstructions(out)
  else writeProjectInstructions(projectId, out)
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

/** 取 tags 命中的分节块全文（全局+项目，含核心节），无内容返回空串；get_writing_rules 工具专用 */
export function writingRulesFor(tags: readonly string[], projectId: string): string {
  return writingRulesBlock(tags, projectId)
}
