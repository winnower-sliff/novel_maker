import type { ChatParams } from '../../shared/types'
import { readGlobalInstructions, readProjectInstructions } from '../agent/instructions'
import * as store from '../store'

/** 指令优化/建议共用的项目素材：题材、风格、世界观与人物概览（仅标题，防撑爆 prompt） */
function instructionContext(projectId: string): string {
  const project = store.listProjects().find((x) => x.id === projectId)
  const parts: string[] = []
  if (project) {
    parts.push(`【作品】${project.title}${project.genre ? `（${project.genre}）` : ''}`)
    if (project.styleGuide.trim()) {
      parts.push(`【风格指南】\n${project.styleGuide.trim().slice(0, 600)}`)
    }
  }
  const wb = store
    .listWorldbuild(projectId)
    .slice(0, 40)
    .map((e) => `- [${e.category}] ${e.title}`)
    .join('\n')
  if (wb) parts.push(`【世界观（仅标题）】\n${wb}`)
  const chars = store
    .listCharacters(projectId)
    .slice(0, 30)
    .map((c) => `- ${c.name}（${c.role || '未定位'}）`)
    .join('\n')
  if (chars) parts.push(`【人物（姓名/定位）】\n${chars}`)
  return parts.join('\n\n')
}

const TAG_GUIDE =
  '分节标签约定（节标题末尾方括号）：[core] 与不带标签=每次任务都注入；[outline] 生成大纲；[chapter] 写正文；[prose] 文笔；[dialogue] 对话；[hooks] 章末钩子；[plot] 剧情；[fore] 伏笔；[character] 人物；[worldbuild] 世界观；[continuity] 连贯性'

/** 节级/整段「AI 优化」请求：保留原意改写，输出纯正文 */
export function buildInstructionRefineRequest(
  projectId: string,
  scope: 'global' | 'project',
  text: string,
  title?: string,
  tag?: string | null
): ChatParams {
  const system =
    scope === 'global'
      ? [
          '你是长篇小说创作系统的指令编辑助手。用户在维护一份「智能体全局写作规则」（agents.md），按 ## 分节管理、按标签注入。',
          '本次任务：改写其中一个分节。要求：',
          '- 保留用户原意与既有要点，不得删除内容；通过补全、压缩、消除歧义让它更清晰、更可执行',
          '- 维持 Markdown 列表结构；输出该节正文（不含 ## 标题行），不要输出任何解释、前言或代码块围栏',
          '- 若原文为空或过于简略，按标题与标签合理补全 3-6 条具体可执行的规则'
        ].join('\n')
      : [
          '你是长篇小说创作系统的指令编辑助手。用户在维护「项目级智能体指令」——仅当前项目生效、优先级高于全局规则。',
          '本次任务：改写这段项目指令。要求：',
          '- 保留用户原意与所有硬性要求，不得删除要点；表述更清晰、更可执行',
          '- 维持 Markdown 结构；只输出改写后的指令全文，不要输出任何解释或代码块围栏',
          '- 若原文为空或过于简略，结合项目设定补全一份实用的项目指令（称呼规范、角色一致性、剧情禁忌、节奏偏好等）'
        ].join('\n')
  const user =
    scope === 'global'
      ? `【节标题】${title?.trim() || '未命名节'}\n【注入标签】${tag ? `[${tag}]` : '无（每次注入）'}\n\n【原文】\n${text.trim() || '（空）'}`
      : `【项目设定概览】\n${instructionContext(projectId)}\n\n【原文】\n${text.trim() || '（空）'}`
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 2048,
    temperature: 0.4,
    purpose: 'outline'
  }
}

/** 「AI 建议」请求：通读项目设定，产出一份完整规则草稿（global=分节 Markdown；project=整段指令） */
export function buildInstructionSuggestRequest(
  projectId: string,
  scope: 'global' | 'project'
): ChatParams {
  const ctx = instructionContext(projectId)
  if (scope === 'global') {
    const cur = readGlobalInstructions().trim().slice(0, 2000)
    const system = [
      '你是长篇小说创作系统的指令架构师。用户要为自己的小说配置「智能体全局写作规则」——一份 Markdown 文档，按 ## 分节。',
      TAG_GUIDE,
      '请通读项目设定概览，输出一份实用的规则草稿：3-6 节，每节 3-6 条具体、可执行、可检验的规则，紧扣题材特点，避免空话套话。',
      '首节建议 [core] 放核心纪律；其余按题材需要选择标签；既有规则中合理的条目可以保留并改进。',
      '只输出 Markdown 正文（以 ## 开头的分节），不要输出解释、前言或代码块围栏。'
    ].join('\n')
    const user = [
      `【项目设定概览】\n${ctx}`,
      cur && `【现有全局规则（可保留改进，避免重复矛盾）】\n${cur}`
    ]
      .filter(Boolean)
      .join('\n\n')
    return {
      model: '',
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 4096,
      temperature: 0.6,
      purpose: 'outline'
    }
  }
  const cur = readProjectInstructions(projectId).trim().slice(0, 1000)
  const system = [
    '你是长篇小说创作系统的指令架构师。用户要为自己的小说配置「项目级智能体指令」——仅当前项目生效、优先级高于全局规则。',
    '请通读项目设定概览，输出一份实用草稿（3-8 条）：它适合放本书专属要求（专属称呼、角色一致性、剧情禁忌、线索管理、节奏偏好等），不要重复通用写作纪律。',
    '只输出 Markdown 正文，不要输出解释、前言或代码块围栏。'
  ].join('\n')
  const user = [
    `【项目设定概览】\n${ctx}`,
    cur && `【现有项目指令（可保留改进，避免重复矛盾）】\n${cur}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 2048,
    temperature: 0.6,
    purpose: 'outline'
  }
}
