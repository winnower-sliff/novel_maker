import type { GraphNodeKind, ProjectGraph, ProjectGraphEdge, ProjectGraphNode } from '../shared/types'
import { splitTags } from '../shared/tags'
import * as store from './store'

const WIKI_LINK_RE = /\[\[([^\[\]]+?)\]\]/g

function extractLinkNames(text: string): string[] {
  return [...new Set([...text.matchAll(WIKI_LINK_RE)].map((m) => m[1].trim()).filter(Boolean))]
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
  const edgeKeys = new Set<string>()
  const edges: ProjectGraphEdge[] = []

  const addEdgesFrom = (sourceId: string, text: string): void => {
    if (!text) return
    for (const name of extractLinkNames(text)) {
      const targetId = nameIndex.get(name)
      if (!targetId || targetId === sourceId) continue
      const key = sourceId < targetId ? `${sourceId}|${targetId}` : `${targetId}|${sourceId}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      edges.push({ source: sourceId, target: targetId })
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
    edges
  }
}
