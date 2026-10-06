import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AgentInstructionsView } from '../../shared/types'
import * as store from '../store'

export function globalAgentsPath(): string {
  return join(app.getPath('userData'), 'agents.md')
}

const GLOBAL_TEMPLATE = `# 智能体全局指令

本文件是跨项目的写作偏好，会注入生成链路与智能体系统提示（位于项目指令之前）。

分节约定：## 标题末尾方括号是注入标签——[core] 和不带标签的节每次任务都完整注入；其他标签只在对应任务时注入（界面「生成」按动作自动带上，智能体做对应任务前先调 get_writing_rules 工具读取相关节）。新建节不带标签即视为每次注入。

示例：

## 核心纪律 [core]

- 章节标题不超过 12 个字。
- 每章结尾留一个钩子。

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
  return {
    globalText: readGlobalInstructions(),
    projectText: readProjectInstructions(projectId),
    globalPath: globalAgentsPath()
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

function parseRuleSections(raw: string): { preamble: string; sections: RuleSection[] } {
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

/** agents.md 不分节（旧版整段文本）时整体视为核心节，行为与历史版本一致 */
function pickRules(tags: readonly string[]): string {
  const raw = readGlobalInstructions()
  if (!raw.trim()) return ''
  const { preamble, sections } = parseCached()
  const wanted = new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))
  const parts = [
    preamble,
    ...sections
      .filter((s) => s.tag === null || s.tag === 'core' || wanted.has(s.tag))
      .map((s) => s.text.trim())
  ].filter(Boolean)
  return parts.join('\n\n')
}

/** 核心节（文件头 + [core] + 无标签节）：agent 系统提示固定注入的部分 */
export function coreWritingRules(): string {
  return pickRules([])
}

/** 取 tags 命中的分节全文（含核心节），无内容返回空串；get_writing_rules 工具与 pipeline 共用 */
export function writingRulesFor(tags: readonly string[]): string {
  return pickRules(tags)
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

/** 把 tags 命中的分节（含核心节）追加到 system 末尾；agents.md 为空时原样返回 */
export function appendWritingRules(system: string, tags: readonly string[]): string {
  const rules = pickRules(tags)
  if (!rules) return system
  const header =
    '【用户全局写作规则（按本次任务带上的分节；与技能模板或上文任何指令冲突时，以本节为准）】'
  return system ? `${system}\n\n${header}\n${rules}` : `${header}\n${rules}`
}
