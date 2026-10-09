import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { SkillFile, SkillMeta } from '../shared/types'
import { BUILTIN_SKILLS } from './builtin-skills'

export function globalSkillsDir(): string {
  return join(app.getPath('userData'), 'skills')
}

function parseFrontmatter(raw: string): {
  name: string
  description: string
  version: number
  always: boolean
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!match) return { name: '', description: '', version: 0, always: false }
  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z_]+)\s*:\s*(.*)$/.exec(line.trim())
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim()
  }
  return {
    name: meta.name ?? '',
    description: meta.description ?? '',
    version: Number(meta.version) || 0,
    always: /^(true|1|yes)$/i.test(meta.always ?? '')
  }
}

function builtinVersion(raw: string): number {
  return parseFrontmatter(raw).version
}

export function listSkills(): SkillMeta[] {
  seedIfEmpty()
  const dir = globalSkillsDir()
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((filename) => {
      const raw = readFileSync(join(dir, filename), 'utf-8')
      const meta = parseFrontmatter(raw)
      return {
        name: meta.name || filename.replace(/\.md$/, ''),
        description: meta.description,
        filename,
        always: meta.always
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 去掉 frontmatter 后的技能正文 */
export function stripFrontmatter(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---/.exec(raw)
  return (match ? raw.slice(match[0].length) : raw).trim()
}

export function getSkill(filename: string): SkillFile | null {
  const dir = globalSkillsDir()
  const path = join(dir, filename)
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf-8')
  const meta = parseFrontmatter(raw)
  return {
    name: meta.name || filename.replace(/\.md$/, ''),
    description: meta.description,
    filename,
    always: meta.always,
    raw
  }
}

export function saveSkill(filename: string, raw: string): void {
  const dir = globalSkillsDir()
  mkdirSync(dir, { recursive: true })
  const safe = filename.replace(/[\\/:*?"<>|]/g, '-')
  writeFileSync(join(dir, safe.endsWith('.md') ? safe : `${safe}.md`), raw, 'utf-8')
}

export function deleteSkill(filename: string): void {
  const path = join(globalSkillsDir(), filename)
  if (existsSync(path)) rmSync(path)
}

function seedIfEmpty(): void {
  const dir = globalSkillsDir()
  mkdirSync(dir, { recursive: true })
  for (const [filename, content] of Object.entries(BUILTIN_SKILLS)) {
    const path = join(dir, filename)
    if (!existsSync(path)) {
      writeFileSync(path, content, 'utf-8')
      continue
    }
    if (builtinVersion(content) > parseFrontmatter(readFileSync(path, 'utf-8')).version) {
      writeFileSync(path, content, 'utf-8')
    }
  }
}
