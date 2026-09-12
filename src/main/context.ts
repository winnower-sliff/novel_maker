import type { BuiltContext, ContextPart } from '../shared/types'
import { splitTags } from '../shared/tags'
import * as store from './store'

const CHARS_PER_TOKEN = 1 / 0.75
const TOKEN_BUDGET = 32000
const RECENT_SUMMARIES = 5

export function estimateTokens(text: string): number {
  return Math.ceil(text.length * CHARS_PER_TOKEN)
}

function part(name: string, detail: string, text: string): ContextPart {
  return { name, detail, tokens: estimateTokens(text) }
}

function renderWorldbuildSlim(projectId: string): { text: string; detail: string } {
  const entries = store.listWorldbuild(projectId)
  if (entries.length === 0) return { text: '', detail: '无' }
  const text = entries.map((e) => `- [${e.category}] ${e.title}`).join('\n')
  return { text, detail: `${entries.length} 条（仅标题）` }
}

function renderWorldbuildFull(projectId: string): { text: string; detail: string } {
  const entries = store.listWorldbuild(projectId)
  if (entries.length === 0) return { text: '', detail: '无' }
  const text = entries
    .map((e) => {
      const tags = splitTags(e.tags)
      const tagSuffix = tags.length > 0 ? `（标签：${tags.join('、')}）` : ''
      return `### [${e.category}] ${e.title}${tagSuffix}\n${e.content}`
    })
    .join('\n\n')
  return { text, detail: `${entries.length} 条（全文）` }
}

function renderCharactersFull(projectId: string): { text: string; detail: string } {
  const list = store.listCharacters(projectId)
  if (list.length === 0) return { text: '', detail: '无' }
  const text = list
    .map((c) => `### ${c.name}（${c.role || '未定位'}${c.tags ? ` · ${c.tags}` : ''}）\n${c.card}`)
    .join('\n\n')
  return { text, detail: `${list.length} 卡（全文）` }
}

function renderCharactersSlim(projectId: string): { text: string; detail: string } {
  const list = store.listCharacters(projectId)
  if (list.length === 0) return { text: '', detail: '无' }
  const text = list.map((c) => `- ${c.name}（${c.role || '未定位'}）`).join('\n')
  return { text, detail: `${list.length} 人（仅名单）` }
}

function renderRecentSummaries(projectId: string, beforeOutlineId: string): { text: string; detail: string; count: number } {
  const outlines = store.listOutlines(projectId)
  const idx = outlines.findIndex((o) => o.id === beforeOutlineId)
  if (idx <= 0) return { text: '', detail: '无', count: 0 }
  const prev = outlines.slice(Math.max(0, idx - RECENT_SUMMARIES), idx)
  const blocks: string[] = []
  let used = 0
  for (const o of [...prev].reverse()) {
    const chapter = store.getChapterByOutline(o.id)
    if (!chapter) continue
    const s = store.getSummary(chapter.id)
    if (!s) continue
    blocks.push(
      [
        `第${o.chapterNo}章（${o.title}）：${s.summary}`,
        s.timeline ? `时间线：${s.timeline}` : '',
        s.characterStates.length > 0
          ? `人物状态：${s.characterStates.map((cs) => `${cs.name}=${cs.state}`).join('；')}`
          : ''
      ]
        .filter(Boolean)
        .join('\n')
    )
    used++
  }
  if (blocks.length === 0) {
    const lastWithDraft = prev
      .slice()
      .reverse()
      .find((o) => store.getChapterByOutline(o.id))
    if (lastWithDraft) {
      const chapter = store.getChapterByOutline(lastWithDraft.id)
      if (chapter) {
        const tail = chapter.content.slice(-800)
        return {
          text: `第${lastWithDraft.chapterNo}章 结尾节选：\n${tail}`,
          detail: '前章结尾节选（无摘要）',
          count: 1
        }
      }
    }
    return { text: '', detail: '无', count: 0 }
  }
  return { text: blocks.join('\n\n'), detail: `最近 ${used} 章摘要`, count: used }
}

function renderForeshadows(projectId: string): { text: string; detail: string } {
  const list = store.listForeshadows(projectId).filter((f) => f.status === 'open')
  if (list.length === 0) return { text: '', detail: '无' }
  const text = list.map((f) => `- ${f.content}（埋于${f.plantedChapter || '?'}）`).join('\n')
  return { text, detail: `${list.length} 条未回收` }
}

export function buildChapterContext(projectId: string, outlineId: string): BuiltContext {
  const project = store
    .listProjects()
    .find((p) => p.id === projectId)
  const outlines = store.listOutlines(projectId)
  const idx = outlines.findIndex((o) => o.id === outlineId)
  if (!project || idx < 0) throw new Error('章节不存在')

  const current = outlines[idx]
  const prev = outlines[idx - 1]
  const next = outlines[idx + 1]

  const styleText = project.styleGuide
  const wbFull = renderWorldbuildFull(projectId)
  const chFull = renderCharactersFull(projectId)
  const summaries = renderRecentSummaries(projectId, outlineId)
  const foreshadows = renderForeshadows(projectId)

  const outlineText = [
    prev ? `上一章（第${prev.chapterNo}章 ${prev.title}）梗概：${prev.synopsis}` : '本章为开篇',
    `本章：第${current.chapterNo}章 ${current.title}\n梗概：${current.synopsis}`,
    next ? `下一章（第${next.chapterNo}章 ${next.title}）梗概：${next.synopsis}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  const estimate = (extra: number): number =>
    estimateTokens(styleText) +
    estimateTokens(wbFull.text) +
    estimateTokens(chFull.text) +
    estimateTokens(summaries.text) +
    estimateTokens(foreshadows.text) +
    estimateTokens(outlineText) +
    extra

  let wb = wbFull
  let ch = chFull
  const instructionLen = 300
  if (estimate(instructionLen) > TOKEN_BUDGET) {
    ch = renderCharactersSlim(projectId)
  }
  if (estimate(instructionLen) > TOKEN_BUDGET) {
    wb = renderWorldbuildSlim(projectId)
  }

  const sections: Array<[string, string]> = ([
    ['【作品风格】', styleText],
    ['【世界观设定】', wb.text],
    ['【人物卡】', ch.text],
    ['【前情摘要】', summaries.text],
    ['【伏笔台账（未回收）】', foreshadows.text],
    ['【本章大纲】', outlineText]
  ] as Array<[string, string]>).filter(([, text]) => text.trim().length > 0)

  const system = sections.map(([head, text]) => `${head}\n${text}`).join('\n\n')
  const user = `请撰写本章正文，2400-3000 字。直接输出正文，可带章节标题。`

  const parts = [
    part('风格指南', project.styleGuide ? '已配置' : '无', styleText),
    part('世界观', wb.detail, wb.text),
    part('人物', ch.detail, ch.text),
    part('前情', summaries.detail, summaries.text),
    part('伏笔', foreshadows.detail, foreshadows.text),
    part('大纲', `当前+前后章`, outlineText)
  ]

  return {
    system,
    user,
    parts,
    totalTokens: parts.reduce((a, p) => a + p.tokens, 0)
  }
}
