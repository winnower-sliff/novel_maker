import { queryOptions } from '@tanstack/react-query'

/**
 * IPC 数据的 query key 与 queryOptions 工厂。
 * 命名规则：['novel', <域>, ...参数]，写操作后按前缀失效：
 *   qc.invalidateQueries({ queryKey: qk.novel })        // 整个小说数据域
 *   qc.invalidateQueries({ queryKey: qk.worldbuild(pid) }) // 精确失效
 */
export const qk = {
  novel: ['novel'] as const,
  projects: ['novel', 'projects'] as const,
  worldbuild: (projectId: string) => ['novel', 'worldbuild', projectId] as const,
  worldbuildTypes: (projectId: string) => ['novel', 'worldbuildTypes', projectId] as const,
  characters: (projectId: string) => ['novel', 'characters', projectId] as const,
  characterAppearances: (projectId: string) =>
    ['novel', 'characterAppearances', projectId] as const,
  outlines: (projectId: string) => ['novel', 'outlines', projectId] as const,
  foreshadows: (projectId: string) => ['novel', 'foreshadows', projectId] as const,
  chapterBriefs: (projectId: string) => ['novel', 'chapterBriefs', projectId] as const,
  chapter: (outlineId: string) => ['novel', 'chapter', outlineId] as const,
  summary: (outlineId: string) => ['novel', 'summary', outlineId] as const,
  volumeSummaries: (projectId: string) => ['novel', 'volumeSummaries', projectId] as const,

  settings: ['settings'] as const,
  usageList: (limit: number) => ['usage', 'list', limit] as const,
  usageStats: ['usage', 'stats'] as const,
  skills: ['skills'] as const,
  agentSessions: (projectId?: string) => ['agentSessions', projectId ?? 'all'] as const,
  /** agentSessions 域前缀：invalidate 时命中全部会话查询（含各 projectId 子键） */
  agentSessionsAll: ['agentSessions'] as const,
  graph: (projectId: string) => ['novel', 'graph', projectId] as const
}

export const queries = {
  projects: () =>
    queryOptions({ queryKey: qk.projects, queryFn: () => window.api.novel.projects() }),
  worldbuild: (projectId: string) =>
    queryOptions({
      queryKey: qk.worldbuild(projectId),
      queryFn: () => window.api.novel.worldbuild(projectId),
      enabled: !!projectId
    }),
  worldbuildTypes: (projectId: string) =>
    queryOptions({
      queryKey: qk.worldbuildTypes(projectId),
      queryFn: () => window.api.novel.worldbuildTypes(projectId),
      enabled: !!projectId
    }),
  characters: (projectId: string) =>
    queryOptions({
      queryKey: qk.characters(projectId),
      queryFn: () => window.api.novel.characters(projectId),
      enabled: !!projectId
    }),
  outlines: (projectId: string) =>
    queryOptions({
      queryKey: qk.outlines(projectId),
      queryFn: () => window.api.novel.outlines(projectId),
      enabled: !!projectId
    }),
  foreshadows: (projectId: string) =>
    queryOptions({
      queryKey: qk.foreshadows(projectId),
      queryFn: () => window.api.novel.foreshadows(projectId),
      enabled: !!projectId
    }),
  chapterBriefs: (projectId: string) =>
    queryOptions({
      queryKey: qk.chapterBriefs(projectId),
      queryFn: () => window.api.novel.chapterBriefs(projectId),
      enabled: !!projectId
    }),
  chapter: (outlineId: string) =>
    queryOptions({
      queryKey: qk.chapter(outlineId),
      queryFn: () => window.api.novel.chapter(outlineId),
      enabled: !!outlineId
    }),
  summary: (outlineId: string) =>
    queryOptions({
      queryKey: qk.summary(outlineId),
      queryFn: () => window.api.novel.summary(outlineId),
      enabled: !!outlineId
    }),
  volumeSummaries: (projectId: string) =>
    queryOptions({
      queryKey: qk.volumeSummaries(projectId),
      queryFn: () => window.api.novel.volumeSummaries(projectId),
      enabled: !!projectId
    }),
  settings: () => queryOptions({ queryKey: qk.settings, queryFn: () => window.api.settings.get() }),
  usageList: (limit: number) =>
    queryOptions({
      queryKey: qk.usageList(limit),
      queryFn: () => window.api.usage.list(limit)
    }),
  usageStats: () =>
    queryOptions({ queryKey: qk.usageStats, queryFn: () => window.api.usage.stats() }),
  skills: () => queryOptions({ queryKey: qk.skills, queryFn: () => window.api.skills.list() }),
  agentSessions: (projectId?: string) =>
    queryOptions({
      queryKey: qk.agentSessions(projectId),
      queryFn: () => window.api.agent.sessions(projectId)
    }),
  graph: (projectId: string) =>
    queryOptions({
      queryKey: qk.graph(projectId),
      queryFn: () => window.api.graph.project(projectId),
      enabled: !!projectId
    })
}
