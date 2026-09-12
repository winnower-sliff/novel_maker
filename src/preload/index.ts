import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentDonePayload,
  AgentSession,
  AgentSessionBrief,
  AgentToolCall,
  BuiltContext,
  Chapter,
  ChapterBrief,
  ChapterSummary,
  Character,
  CharacterInput,
  ChatMessage,
  ChatParams,
  ChatResult,
  Foreshadow,
  ForeshadowInput,
  ModelProbeResult,
  OutlineGenParams,
  OutlineInput,
  OutlineItem,
  PipelineAction,
  Project,
  ProjectGraph,
  ProjectInput,
  SettingsPatch,
  SettingsView,
  SkillFile,
  SkillMeta,
  UsageRecord,
  UsageStats,
  WorldbuildEntry,
  WorldbuildInput
} from '../shared/types'

export type DonePayload = Pick<
  ChatResult,
  'usage' | 'model' | 'stopReason' | 'durationMs' | 'headers'
> & {
  action?: PipelineAction
  data?: unknown
}

export interface AgentToolCallEvent extends Omit<AgentToolCall, 'state'> {
  state: AgentToolCall['state']
}

export interface AgentToolResultEvent {
  id: string
  ok: boolean
  result: string
  denied?: boolean
}

const api = {
  settings: {
    get: (): Promise<SettingsView> => ipcRenderer.invoke('settings:get'),
    save: (patch: SettingsPatch): Promise<SettingsView> => ipcRenderer.invoke('settings:save', patch)
  },
  models: {
    probe: (apiKeyOverride?: string): Promise<ModelProbeResult> =>
      ipcRenderer.invoke('models:probe', apiKeyOverride)
  },
  llm: {
    chat: (params: ChatParams): Promise<string> => ipcRenderer.invoke('llm:chat', params),
    abort: (requestId: string): Promise<void> => ipcRenderer.invoke('llm:abort', requestId),
    onDelta: (cb: (requestId: string, text: string) => void): (() => void) => {
      const listener = (_e: unknown, requestId: string, text: string): void => cb(requestId, text)
      ipcRenderer.on('llm:delta', listener)
      return () => ipcRenderer.off('llm:delta', listener)
    },
    onDone: (cb: (requestId: string, payload: DonePayload) => void): (() => void) => {
      const listener = (_e: unknown, requestId: string, payload: DonePayload): void =>
        cb(requestId, payload)
      ipcRenderer.on('llm:done', listener)
      return () => ipcRenderer.off('llm:done', listener)
    },
    onError: (cb: (requestId: string, message: string) => void): (() => void) => {
      const listener = (_e: unknown, requestId: string, message: string): void =>
        cb(requestId, message)
      ipcRenderer.on('llm:error', listener)
      return () => ipcRenderer.off('llm:error', listener)
    }
  },
  usage: {
    list: (limit?: number): Promise<UsageRecord[]> => ipcRenderer.invoke('usage:list', limit),
    stats: (): Promise<UsageStats> => ipcRenderer.invoke('usage:stats')
  },
  novel: {
    projects: (): Promise<Project[]> => ipcRenderer.invoke('novel:projects'),
    projectCreate: (input: ProjectInput): Promise<Project> =>
      ipcRenderer.invoke('novel:projectCreate', input),
    projectUpdate: (id: string, input: Partial<ProjectInput>): Promise<void> =>
      ipcRenderer.invoke('novel:projectUpdate', id, input),
    projectDelete: (id: string): Promise<void> => ipcRenderer.invoke('novel:projectDelete', id),
    characters: (projectId: string): Promise<Character[]> =>
      ipcRenderer.invoke('novel:characters', projectId),
    characterSave: (input: CharacterInput & { id?: string }): Promise<Character> =>
      ipcRenderer.invoke('novel:characterSave', input),
    characterDelete: (id: string): Promise<void> => ipcRenderer.invoke('novel:characterDelete', id),
    worldbuild: (projectId: string): Promise<WorldbuildEntry[]> =>
      ipcRenderer.invoke('novel:worldbuild', projectId),
    worldbuildSave: (input: WorldbuildInput & { id?: string }): Promise<WorldbuildEntry> =>
      ipcRenderer.invoke('novel:worldbuildSave', input),
    worldbuildDelete: (id: string): Promise<void> =>
      ipcRenderer.invoke('novel:worldbuildDelete', id),
    worldbuildTypes: (projectId: string): Promise<string[]> =>
      ipcRenderer.invoke('novel:worldbuildTypes', projectId),
    worldbuildTypeCreate: (projectId: string, name: string): Promise<string[]> =>
      ipcRenderer.invoke('novel:worldbuildTypeCreate', projectId, name),
    worldbuildTypeDelete: (projectId: string, name: string): Promise<string[]> =>
      ipcRenderer.invoke('novel:worldbuildTypeDelete', projectId, name),
    outlines: (projectId: string): Promise<OutlineItem[]> =>
      ipcRenderer.invoke('novel:outlines', projectId),
    outlineSave: (input: OutlineInput & { id?: string }): Promise<OutlineItem> =>
      ipcRenderer.invoke('novel:outlineSave', input),
    outlineDelete: (id: string): Promise<void> => ipcRenderer.invoke('novel:outlineDelete', id),
    chapterBriefs: (projectId: string): Promise<ChapterBrief[]> =>
      ipcRenderer.invoke('novel:chapterBriefs', projectId),
    chapter: (outlineId: string): Promise<Chapter | null> =>
      ipcRenderer.invoke('novel:chapter', outlineId),
    saveChapter: (input: {
      outlineId: string
      projectId: string
      content: string
      status?: string
    }): Promise<Chapter> => ipcRenderer.invoke('novel:saveChapter', input),
    contextPreview: (outlineId: string): Promise<BuiltContext> =>
      ipcRenderer.invoke('novel:contextPreview', outlineId),
    foreshadows: (projectId: string): Promise<Foreshadow[]> =>
      ipcRenderer.invoke('novel:foreshadows', projectId),
    foreshadowSave: (input: ForeshadowInput & { id?: string }): Promise<Foreshadow> =>
      ipcRenderer.invoke('novel:foreshadowSave', input),
    foreshadowDelete: (id: string): Promise<void> =>
      ipcRenderer.invoke('novel:foreshadowDelete', id),
    summary: (outlineId: string): Promise<ChapterSummary | null> =>
      ipcRenderer.invoke('novel:summary', outlineId)
  },
  pipeline: {
    run: (action: PipelineAction, params: unknown): Promise<string> =>
      ipcRenderer.invoke('pipeline:run', action, params)
  },
  agent: {
    run: (params: { projectId: string; messages: ChatMessage[]; model?: string }): Promise<string> =>
      ipcRenderer.invoke('agent:run', params),
    abort: (requestId: string): Promise<void> => ipcRenderer.invoke('agent:abort', requestId),
    resolve: (requestId: string, confirmId: string, allow: boolean, always?: boolean): Promise<boolean> =>
      ipcRenderer.invoke('agent:resolve', requestId, confirmId, allow, always),
    sessions: (projectId?: string): Promise<AgentSessionBrief[]> =>
      ipcRenderer.invoke('agent:sessions', projectId),
    sessionLoad: (id: string): Promise<AgentSession | null> =>
      ipcRenderer.invoke('agent:sessionLoad', id),
    sessionSave: (session: AgentSession): Promise<void> =>
      ipcRenderer.invoke('agent:sessionSave', session),
    sessionDelete: (id: string): Promise<void> => ipcRenderer.invoke('agent:sessionDelete', id),
    onDelta: (cb: (requestId: string, text: string) => void): (() => void) => {
      const listener = (_e: unknown, requestId: string, text: string): void => cb(requestId, text)
      ipcRenderer.on('agent:delta', listener)
      return () => ipcRenderer.off('agent:delta', listener)
    },
    onToolCall: (
      cb: (requestId: string, call: AgentToolCallEvent) => void
    ): (() => void) => {
      const listener = (_e: unknown, requestId: string, call: AgentToolCallEvent): void =>
        cb(requestId, call)
      ipcRenderer.on('agent:toolCall', listener)
      return () => ipcRenderer.off('agent:toolCall', listener)
    },
    onToolResult: (cb: (requestId: string, r: AgentToolResultEvent) => void): (() => void) => {
      const listener = (_e: unknown, requestId: string, r: AgentToolResultEvent): void =>
        cb(requestId, r)
      ipcRenderer.on('agent:toolResult', listener)
      return () => ipcRenderer.off('agent:toolResult', listener)
    },
    onDone: (cb: (requestId: string, payload: AgentDonePayload) => void): (() => void) => {
      const listener = (_e: unknown, requestId: string, payload: AgentDonePayload): void =>
        cb(requestId, payload)
      ipcRenderer.on('agent:done', listener)
      return () => ipcRenderer.off('agent:done', listener)
    },
    onError: (cb: (requestId: string, message: string) => void): (() => void) => {
      const listener = (_e: unknown, requestId: string, message: string): void => cb(requestId, message)
      ipcRenderer.on('agent:error', listener)
      return () => ipcRenderer.off('agent:error', listener)
    }
  },
  exporter: {
    run: (opts: {
      projectId: string
      format: 'txt' | 'md' | 'docx'
      scope: 'all' | 'single'
      outlineId?: string
    }): Promise<{ path: string; words: number }> => ipcRenderer.invoke('export:run', opts)
  },
  graph: {
    project: (projectId: string): Promise<ProjectGraph> =>
      ipcRenderer.invoke('graph:project', projectId)
  },
  skills: {
    list: (): Promise<SkillMeta[]> => ipcRenderer.invoke('skills:list'),
    get: (filename: string): Promise<SkillFile | null> => ipcRenderer.invoke('skills:get', filename),
    save: (filename: string, raw: string): Promise<void> =>
      ipcRenderer.invoke('skills:save', filename, raw),
    delete: (filename: string): Promise<void> => ipcRenderer.invoke('skills:delete', filename)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
