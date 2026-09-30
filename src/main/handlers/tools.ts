import type { SearchHit } from '../../shared/types'
import {
  getEmbeddingStatus,
  rebuildEmbeddings,
  semanticSearch,
  setEmbeddingEnabled
} from '../embedding'
import { buildProjectGraph } from '../graph'
import { lintChapterReport } from '../lint'
import { deleteSkill, getSkill, listSkills, saveSkill } from '../skills'
import * as store from '../store'
import { computeStats, listUsage } from '../usage'
import type { PartialHandlerTable } from './context'

export const toolHandlers = {
  'usage:list': (_ctx, [limit]) => listUsage(limit ?? 200),
  'usage:stats': () => computeStats(),

  'lint:run': (_ctx, [outlineId, text]) => lintChapterReport(outlineId, text),

  'embedding:status': (_ctx, [projectId]) => getEmbeddingStatus(projectId),
  'embedding:setEnabled': (_ctx, [enabled]) => setEmbeddingEnabled(enabled),
  'embedding:rebuild': async (_ctx, [projectId]) => ({
    count: await rebuildEmbeddings(projectId)
  }),

  'search:project': async (_ctx, [projectId, query, limit]) => {
    const k = Math.min(20, Math.max(1, limit ?? 8))
    const hits = await semanticSearch(projectId, query, ['worldbuild', 'character', 'summary'], k)
    const wb = new Map(store.listWorldbuild(projectId).map((e) => [e.id, e]))
    const ch = new Map(store.listCharacters(projectId).map((c) => [c.id, c]))
    const ol = new Map(store.listOutlines(projectId).map((o) => [o.id, o]))
    const out: SearchHit[] = []
    for (const h of hits) {
      if (h.kind === 'worldbuild') {
        const e = wb.get(h.refId)
        if (e)
          out.push({
            kind: 'worldbuild',
            id: e.id,
            title: `[${e.category}] ${e.title}`,
            snippet: e.content.slice(0, 160),
            score: h.score
          })
      } else if (h.kind === 'character') {
        const c = ch.get(h.refId)
        if (c)
          out.push({
            kind: 'character',
            id: c.id,
            title: `${c.name}（${c.role || '未定位'}）`,
            snippet: c.card.slice(0, 160),
            score: h.score
          })
      } else if (h.kind === 'summary') {
        const o = ol.get(h.refId)
        const chapter = o ? store.getChapterByOutline(o.id) : null
        const s = chapter ? store.getSummary(chapter.id) : null
        if (o && s)
          out.push({
            kind: 'chapter',
            id: o.id,
            title: `第${o.chapterNo}章 ${o.title}`,
            snippet: s.summary.slice(0, 160),
            score: h.score
          })
      }
    }
    return out
  },

  'graph:project': (_ctx, [projectId]) => buildProjectGraph(projectId),

  'skills:list': () => listSkills(),
  'skills:get': (_ctx, [filename]) => getSkill(filename),
  'skills:save': (_ctx, [filename, raw]) => saveSkill(filename, raw),
  'skills:delete': (_ctx, [filename]) => deleteSkill(filename)
} satisfies PartialHandlerTable
