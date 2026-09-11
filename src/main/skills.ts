import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { SkillFile, SkillMeta } from '../shared/types'
import { BUILTIN_SKILLS } from './builtin-skills'

export function globalSkillsDir(): string {
  return join(app.getPath('userData'), 'skills')
}

function parseFrontmatter(raw: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!match) return { name: '', description: '' }
  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z_]+)\s*:\s*(.*)$/.exec(line.trim())
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim()
  }
  return { name: meta.name ?? '', description: meta.description ?? '' }
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
        filename
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
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
  if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.md'))) return
  mkdirSync(dir, { recursive: true })
  for (const [filename, content] of Object.entries(BUILTIN_SKILLS)) {
    writeFileSync(join(dir, filename), content, 'utf-8')
  }
}
