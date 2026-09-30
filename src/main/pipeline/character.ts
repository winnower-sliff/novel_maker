import { splitHeadingHashtags, splitTags } from '../../shared/tags'
import type { ChatParams } from '../../shared/types'
import * as store from '../store'
import { skillBody } from './util'

export function buildStateSyncRequest(projectId: string, outlineId: string): ChatParams {
  const outline = store.getOutline(outlineId)
  const chapter = outline ? store.getChapterByOutline(outlineId) : null
  const summary = chapter ? store.getSummary(chapter.id) : null
  if (!outline || !summary) throw new Error('该章节还没有定稿摘要，无法同步人物状态')
  const characters = store.listCharacters(projectId)
  const affected = characters.filter((c) =>
    summary.characterStates.some(
      (cs) =>
        cs.name.trim() === c.name.trim() ||
        c.name.includes(cs.name.trim()) ||
        cs.name.includes(c.name.trim())
    )
  )
  if (affected.length === 0)
    return {
      model: '',
      system: '',
      messages: [{ role: 'user', content: 'noop' }],
      maxTokens: 16,
      temperature: 0,
      purpose: 'summary'
    }
  const blocks = affected
    .map((c) => {
      const changes = summary.characterStates
        .filter(
          (cs) =>
            cs.name.trim() === c.name.trim() ||
            c.name.includes(cs.name.trim()) ||
            cs.name.includes(c.name.trim())
        )
        .map((cs) => `- ${cs.state}`)
        .join('\n')
      return `### ${c.name}\n【当前状态文档】\n${c.state.trim() || '（空——请按分区结构新建：物品/能力/身心状态/关系/最近事件）'}\n【第${outline.chapterNo}章的变化】\n${changes}`
    })
    .join('\n\n')
  const system = skillBody('state-syncer')
  const user = `请合并以下人物的状态变化，输出每人更新后的完整状态文档：\n\n${blocks}`
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 4096,
    temperature: 0.2,
    purpose: 'summary'
  }
}

export interface ParsedCharacterState {
  name: string
  state: string
}

export function parseCharacterStates(text: string): ParsedCharacterState[] {
  const out: ParsedCharacterState[] = []
  let current: { name: string; body: string[] } | null = null
  for (const line of text.split(/\r?\n/)) {
    const m = /^#{1,3}\s*(.+?)\s*$/.exec(line)
    if (m && !/^[（(【]/.test(m[1])) {
      if (current?.body.join('').trim()) {
        out.push({ name: current.name, state: current.body.join('\n').trim() })
      }
      current = { name: m[1].replace(/[（(【].*$/, '').trim(), body: [] }
    } else if (current) {
      current.body.push(line)
    }
  }
  if (current?.body.join('').trim()) {
    out.push({ name: current.name, state: current.body.join('\n').trim() })
  }
  return out
}

export function applyStateSyncResult(
  projectId: string,
  text: string
): { updated: Array<{ id: string; name: string }>; parsed: boolean } {
  const parsed = parseCharacterStates(text)
  if (parsed.length === 0) return { updated: [], parsed: false }
  const characters = store.listCharacters(projectId)
  const updated: Array<{ id: string; name: string }> = []
  for (const p of parsed) {
    const hit = characters.find(
      (c) => c.name.trim() === p.name || c.name.includes(p.name) || p.name.includes(c.name.trim())
    )
    if (!hit) continue
    store.saveCharacter({
      id: hit.id,
      projectId,
      name: hit.name,
      state: p.state
    })
    updated.push({ id: hit.id, name: hit.name })
  }
  return { updated, parsed: updated.length > 0 }
}

export function buildCharacterRequest(
  projectId: string,
  brief: string,
  allowUpdate = false
): ChatParams {
  const project = store.listProjects().find((x) => x.id === projectId)
  const wb = store
    .listWorldbuild(projectId)
    .map((e) => `- [${e.category}] ${e.title}`)
    .join('\n')
  const characters = store.listCharacters(projectId)
  const chars = allowUpdate
    ? characters
        .map((c) => `### ${c.name}（${c.role || '未定位'}）\n${c.card.slice(0, 800)}`)
        .join('\n\n')
    : characters.map((c) => `- ${c.name}（${c.role || '未定位'}）`).join('\n')
  const tagCounts = new Map<string, number>()
  for (const c of characters) {
    for (const t of splitTags(c.tags)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  }
  const tagLine =
    tagCounts.size > 0
      ? `【已有标签（必须优先复用；新建标签须是可被多个人物共享的主题词）】\n${[...tagCounts.entries()].map(([name, count]) => `${name}(${count})`).join('、')}`
      : ''
  const system = [
    skillBody('character-smith'),
    project?.styleGuide && `【作品风格】\n${project.styleGuide}`,
    wb && `【世界观条目】\n${wb}`,
    tagLine,
    chars &&
      (allowUpdate
        ? `【已有人物（新人物的定位与关系须与他们咬合不矛盾。若有人物需要因新人物/新设定调整定位、关系或履历，可按输出格式约定追加修订卡；只能修订上面列出的人物）】\n${chars}`
        : `【已有人物（避免定位重复，需咬合关系网）】\n${chars}`)
  ]
    .filter(Boolean)
    .join('\n\n')
  const user = [
    brief,
    '',
    ...(allowUpdate
      ? [
          '输出格式（严格遵守）：',
          '- 首先输出新人物的完整人物卡，以「## 人物名 #标签1 #标签2」标题行开头（行尾必须带 2-4 个 #标签），正文为自由 markdown 要点式；',
          '- 若上面列出的已有人物中有人需要调整（如与新人物建立师徒/敌对关系、阵营变动、履历补写），在主卡之后追加修订卡：标题行写「## [修订] 原人物名 #标签1 #标签2」（原人物名须逐字一致；没有新标签时标题行可只写原人物名，表示沿用原标签），正文为修订后的完整人物卡（保留原有有效信息，只调整需要变化的部分）；',
          '- 没有需要修订的人物时不要输出任何修订卡，也不要输出总结或解释。'
        ]
      : [
          '输出格式（严格遵守）：',
          '- 每个人物以「## 人物名 #标签1 #标签2」标题行开头（行尾必须带 2-4 个 #标签），正文为自由 markdown 要点式人物卡；',
          '- 不要输出总开场白、总结语或对格式本身的解释。'
        ])
  ].join('\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: allowUpdate ? 8192 : 4096,
    temperature: 0.8,
    purpose: 'outline'
  }
}

export function guessCharacterName(card: string, fallback: string): string {
  const heading = /^#{1,3}\s*(.+)$/m.exec(card)
  if (heading) {
    const { title } = splitHeadingHashtags(heading[1])
    const name = title.replace(/[（(【].*$/, '').trim()
    if (name) return name.slice(0, 20)
  }
  return fallback || '新人物'
}

export interface ParsedCharacterRevision {
  name: string
  tags: string[]
  card: string
}

const REVISE_HEADING = /^#{1,3}\s*\[修订\]\s*(.+?)\s*$/

function stripNameDecorations(raw: string): string {
  return raw
    .replace(/[（(【].*$/, '')
    .trim()
    .slice(0, 20)
}

export function parseCharacterCards(text: string): {
  main: string
  mainTags: string[]
  revisions: ParsedCharacterRevision[]
} {
  const mainLines: string[] = []
  const revisions: ParsedCharacterRevision[] = []
  let current: { name: string; tags: string[]; body: string[] } | null = null
  for (const line of text.split(/\r?\n/)) {
    const m = REVISE_HEADING.exec(line)
    if (m) {
      if (current) {
        revisions.push({
          name: current.name,
          tags: current.tags,
          card: `## ${current.name}\n${current.body.join('\n').replace(/^\n+|\n+$/g, '')}`
        })
      }
      const { title, tags } = splitHeadingHashtags(m[1])
      current = { name: stripNameDecorations(title), tags, body: [] }
    } else if (current) {
      current.body.push(line)
    } else {
      mainLines.push(line)
    }
  }
  if (current) {
    revisions.push({
      name: current.name,
      tags: current.tags,
      card: `## ${current.name}\n${current.body.join('\n').replace(/^\n+|\n+$/g, '')}`
    })
  }
  let main = mainLines.join('\n').replace(/^\n+|\n+$/g, '')
  let mainTags: string[] = []
  const mainHeading = /^(#{1,3})\s*(?!\[修订\])(.+?)\s*$/m.exec(main)
  if (mainHeading) {
    const { title, tags } = splitHeadingHashtags(mainHeading[2])
    mainTags = tags
    if (tags.length > 0) main = main.replace(mainHeading[0], `${mainHeading[1]} ${title}`)
  }
  return { main, mainTags, revisions }
}
