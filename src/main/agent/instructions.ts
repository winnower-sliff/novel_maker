import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AgentInstructionsView } from '../../shared/types'
import * as store from '../store'

export function globalAgentsPath(): string {
  return join(app.getPath('userData'), 'agents.md')
}

const GLOBAL_TEMPLATE = `# 智能体全局指令

本文件的内容会注入每个项目的智能体系统提示（位于项目指令之前）。
适合放：跨项目的写作偏好、称谓习惯、章节结构偏好、命名风格等。

示例：
- 章节标题不超过 12 个字。
- 对话占比保持在 40% 左右，避免大段独白。
- 每章结尾留一个钩子。
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
