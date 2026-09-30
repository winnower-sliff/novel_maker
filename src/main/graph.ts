import { splitTags } from '../shared/tags'
import type {
  GraphNodeKind,
  ProjectGraph,
  ProjectGraphEdge,
  ProjectGraphNode
} from '../shared/types'
import * as store from './store'

/** 解析 [[目标]] 与 [[目标|关系]]，返回 {名字 → 关系(可空)} */
function extractLinks(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of text.matchAll(/\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g)) {
    const name = m[1].trim()
    if (name && !out.has(name)) out.set(name, (m[2] ?? '').trim())
  }
  return out
}

export function buildProjectGraph(projectId: string): ProjectGraph {
  const nodes: ProjectGraphNode[] = []
  const nameIndex = new Map<string, string>()

  const register = (
    id: string,
    rawId: string,
    kind: GraphNodeKind,
    label: string,
    names: string[],
    tags: string[] = []
  ): void => {
    nodes.push({ id, rawId, kind, label, degree: 0, tags: tags.length > 0 ? tags : undefined })
    for (const n of names) {
      if (n && !nameIndex.has(n)) nameIndex.set(n, id)
    }
  }

  const characters = store.listCharacters(projectId)
  const worldbuild = store.listWorldbuild(projectId)
  const outlines = store.listOutlines(projectId)
  const foreshadows = store.listForeshadows(projectId)

  for (const c of characters) {
    register(`char:${c.id}`, c.id, 'character', c.name, [c.name], splitTags(c.tags))
  }
  for (const e of worldbuild) {
    register(`wb:${e.id}`, e.id, 'worldbuild', e.title, [e.title], splitTags(e.tags))
  }
  for (const o of outlines) {
    register(`outline:${o.id}`, o.id, 'outline', `第${o.chapterNo}章 ${o.title}`.trim(), [
      o.title,
      `第${o.chapterNo}章`
    ])
  }
  for (const f of foreshadows) {
    register(`fore:${f.id}`, f.id, 'foreshadow', f.content.slice(0, 16) || '伏笔', [])
  }

  const degree = new Map<string, number>()
  const dangling = new Map<string, number>()
  const edgeByKey = new Map<string, ProjectGraphEdge>()
  const edges: ProjectGraphEdge[] = []

  const edgeKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

  const addEdgesFrom = (sourceId: string, text: string): void => {
    if (!text) return
    for (const [name, rel] of extractLinks(text)) {
      const targetId = nameIndex.get(name)
      if (!targetId) {
        dangling.set(name, (dangling.get(name) ?? 0) + 1)
        continue
      }
      if (targetId === sourceId) continue
      const key = edgeKey(sourceId, targetId)
      const existing = edgeByKey.get(key)
      if (existing) {
        if (rel) {
          const parts = new Set([...(existing.rel ? existing.rel.split('、') : []), rel])
          existing.rel = [...parts].join('、')
        }
        continue
      }
      const edge: ProjectGraphEdge = { source: sourceId, target: targetId, rel: rel || undefined }
      edgeByKey.set(key, edge)
      edges.push(edge)
      degree.set(sourceId, (degree.get(sourceId) ?? 0) + 1)
      degree.set(targetId, (degree.get(targetId) ?? 0) + 1)
    }
  }

  for (const c of characters) addEdgesFrom(`char:${c.id}`, c.card)
  for (const e of worldbuild) addEdgesFrom(`wb:${e.id}`, e.content)
  for (const o of outlines) addEdgesFrom(`outline:${o.id}`, o.synopsis)
  for (const f of foreshadows) addEdgesFrom(`fore:${f.id}`, f.content)
  for (const o of outlines) {
    const chapter = store.getChapterByOutline(o.id)
    if (chapter) addEdgesFrom(`outline:${o.id}`, chapter.content)
  }

  return {
    nodes: nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })),
    edges,
    danglingLinks: [...dangling.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
      .slice(0, 50)
  }
}
