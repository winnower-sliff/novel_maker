import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type {
  AgentDonePayload,
  AgentSession,
  AgentSessionBrief,
  Chapter,
  ChapterBrief,
  ChapterSummary,
  Character,
  CharacterGenParams,
  CharacterInput,
  ChatMessage,
  ChatParams,
  ChatResult,
  Foreshadow,
  ForeshadowInput,
  ModelProbeOptions,
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
  WorldbuildGenParams,
  WorldbuildInput,
  WorldbuildPreviewEntry
} from '../shared/types'
import { cancelAgentConfirms, resolveAgentConfirm, runAgent } from './agent'
import {
  deleteAgentSession,
  listAgentSessions,
  loadAgentSession,
  saveAgentSession
} from './agentSessions'
import { buildChapterContext } from './context'
import { exportProject } from './export'
import { buildProjectGraph } from './graph'
import { chatStream, LlmError, pickRatelimitHeaders, probeModels } from './llm'
import { providerPreset } from '../shared/providers'
import {
  applyOutlineResult,
  applySummaryResult,
  buildChapterRequest,
  buildCharacterRequest,
  buildCheckRequest,
  buildOutlineRequest,
  buildPolishRequest,
  buildSummaryRequest,
  buildWorldbuildIndex,
  buildWorldbuildRequest,
  buildWorldbuildRetrieveRequest,
  commitWorldbuildChunk,
  guessCharacterName,
  parseCharacterCards,
  parseCheckResult,
  previewWorldbuildResult,
  relinkWorldbuildEntries,
  resolveWorldbuildRetrieval,
  saveWorldbuildBatch,
  type WorldbuildRetrieval
} from './pipeline'
import { getApiKeyFor, getLlmAuth, loadSettingsView, saveSettings } from './settings'
import * as store from './store'
import { deleteSkill, getSkill, listSkills, saveSkill } from './skills'
import { appendUsage, computeStats, listUsage } from './usage'

const activeRequests = new Map<string, AbortController>()
const activeAgentRuns = new Map<string, AbortController>()

function startAgentRun(
  e: IpcMainInvokeEvent,
  params: { projectId: string; messages: ChatMessage[]; model?: string }
): string {
  const requestId = randomUUID()
  const controller = new AbortController()
  activeAgentRuns.set(requestId, controller)

  void (async () => {
    let payload: AgentDonePayload
    try {
      const s = await loadSettingsView()
      const model = params.model?.trim() || s.modelRouting.agent || s.defaultModel
      payload = await runAgent({
        win: e.sender,
        requestId,
        projectId: params.projectId,
        messages: params.messages,
        model,
        signal: controller.signal
      })
    } catch (err) {
      if (!e.sender.isDestroyed()) {
        const message = controller.signal.aborted
          ? '已停止'
          : ((err as Error)?.message ?? String(err))
        e.sender.send('agent:error', requestId, message)
      }
      return
    } finally {
      activeAgentRuns.delete(requestId)
    }
    if (!e.sender.isDestroyed()) e.sender.send('agent:done', requestId, payload)
  })()

  return requestId
}

const CONTINUE_PROMPT =
  '输出因长度限制被中断。请从中断处继续输出剩余条目：直接续写正文，不要重复已输出的任何内容，不要开场白或解释，保持完全相同的输出格式，直到全部条目输出完毕。'

function longestOverlapLen(prev: string, next: string, window = 200): number {
  const max = Math.min(window, prev.length, next.length)
  for (let n = max; n > 0; n--) {
    if (prev.endsWith(next.slice(0, n))) return n
  }
  return 0
}

function startStream(
  win: WebContents,
  rawParams: ChatParams,
  opts?: {
    action?: PipelineAction
    afterDone?: (result: ChatResult) => unknown
    continueOnMaxTokens?: number
  }
): string {
  const requestId = randomUUID()
  const controller = new AbortController()
  activeRequests.set(requestId, controller)

  void (async () => {
    try {
      const auth = await getLlmAuth()
      if (!auth.apiKey && auth.needsKey) throw new Error('未配置 API Key，请先在设置中填写')
      const params: ChatParams = { ...rawParams }
      if (!params.model) {
        const s = await loadSettingsView()
        params.model =
          (params.purpose && s.modelRouting[params.purpose]) || s.defaultModel
      }
      if (auth.promptCache && params.system) params.cacheSystem = true

      const send = (text: string): void => {
        if (!win.isDestroyed()) win.send('llm:delta', requestId, text)
      }

      let fullText = ''
      let result: ChatResult | null = null
      let totalMs = 0
      let round = 0
      const maxRounds = opts?.continueOnMaxTokens ?? 0

      for (;;) {
        let pending = ''
        let deduped = round === 0
        const flush = (): void => {
          if (!pending) return
          if (!deduped) {
            deduped = true
            pending = pending.slice(longestOverlapLen(fullText, pending))
          }
          fullText += pending
          send(pending)
          pending = ''
        }
        const onDelta = (text: string): void => {
          if (deduped) {
            fullText += text
            send(text)
            return
          }
          pending += text
          if (pending.length >= 200 || pending.includes('\n')) flush()
        }

        result = await chatStream(params, { apiKey: auth.apiKey, baseUrl: auth.baseUrl }, onDelta, controller.signal)
        flush()
        totalMs += result.durationMs
        appendUsage({
          ts: Date.now(),
          model: result.model,
          purpose: params.purpose ?? 'playground',
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheCreationTokens: result.usage.cacheCreationTokens,
          durationMs: result.durationMs,
          ratelimit: pickRatelimitHeaders(result.headers)
        })

        if (result.stopReason !== 'max_tokens' || round >= maxRounds || controller.signal.aborted) {
          break
        }
        round++
        params.messages = [
          ...params.messages,
          { role: 'assistant', content: fullText },
          { role: 'user', content: CONTINUE_PROMPT }
        ]
      }

      const final = result as ChatResult
      let data: unknown
      let dataError: string | undefined
      try {
        data = opts?.afterDone?.({ ...final, text: fullText, durationMs: totalMs })
      } catch (err) {
        dataError = (err as Error)?.message ?? String(err)
      }

      if (!win.isDestroyed()) {
        win.send('llm:done', requestId, {
          usage: final.usage,
          model: final.model,
          stopReason: final.stopReason,
          durationMs: totalMs,
          headers: final.headers,
          action: opts?.action,
          data: dataError ? { error: dataError } : data
        })
      }
    } catch (err) {
      if (!win.isDestroyed()) {
        const message =
          err instanceof LlmError
            ? `[${err.status ?? '网络'}] ${err.message}`
            : ((err as Error)?.message ?? String(err))
        win.send('llm:error', requestId, message)
      }
    } finally {
      activeRequests.delete(requestId)
    }
  })()

  return requestId
}

async function runWorldbuildRetrieval(p: WorldbuildGenParams): Promise<WorldbuildRetrieval | undefined> {
  const req = buildWorldbuildRetrieveRequest(p)
  if (!req) return undefined
  try {
    const auth = await getLlmAuth()
    if (!auth.apiKey && auth.needsKey) return undefined
    const s = await loadSettingsView()
    const params: ChatParams = { ...req }
    if (!params.model) {
      params.model = (params.purpose && s.modelRouting[params.purpose]) || s.defaultModel
    }
    const result = await chatStream(params, { apiKey: auth.apiKey, baseUrl: auth.baseUrl }, () => {})
    appendUsage({
      ts: Date.now(),
      model: result.model,
      purpose: 'outline',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheCreationTokens: result.usage.cacheCreationTokens,
      durationMs: result.durationMs,
      ratelimit: pickRatelimitHeaders(result.headers)
    })
    return resolveWorldbuildRetrieval(p, buildWorldbuildIndex(p.projectId), result.text)
  } catch {
    return undefined
  }
}

export function registerIpc(): void {
  ipcMain.handle('settings:get', (): Promise<SettingsView> => loadSettingsView())
  ipcMain.handle('settings:save', (_e, patch: SettingsPatch): Promise<SettingsView> =>
    saveSettings(patch)
  )

  ipcMain.handle(
    'models:probe',
    async (_e, opts?: ModelProbeOptions): Promise<ModelProbeResult> => {
      const view = await loadSettingsView()
      const provider = opts?.provider ?? view.provider
      const providerView = view.profiles[provider]
      const apiKey = opts?.apiKey?.trim() || (await getApiKeyFor(provider))
      const baseUrl = opts?.baseUrl?.trim() || providerView.baseUrl
      if (!apiKey && providerPreset(provider).needsKey) throw new Error('未配置 API Key')
      return probeModels({ provider, apiKey, baseUrl })
    }
  )

  ipcMain.handle('llm:chat', (e: IpcMainInvokeEvent, params: ChatParams): string =>
    startStream(e.sender, params)
  )

  ipcMain.handle('llm:abort', (_e, requestId: string): void => {
    activeRequests.get(requestId)?.abort()
  })

  ipcMain.handle(
    'agent:run',
    (e: IpcMainInvokeEvent, params: { projectId: string; messages: ChatMessage[]; model?: string }): string =>
      startAgentRun(e, params)
  )
  ipcMain.handle('agent:abort', (_e, requestId: string): void => {
    activeAgentRuns.get(requestId)?.abort()
    cancelAgentConfirms(requestId)
  })
  ipcMain.handle(
    'agent:resolve',
    (_e, requestId: string, confirmId: string, allow: boolean, always?: boolean): boolean =>
      resolveAgentConfirm(requestId, confirmId, allow, !!always)
  )
  ipcMain.handle('agent:sessions', (_e, projectId?: string): AgentSessionBrief[] =>
    listAgentSessions(projectId)
  )
  ipcMain.handle('agent:sessionLoad', (_e, id: string): AgentSession | null => loadAgentSession(id))
  ipcMain.handle('agent:sessionSave', (_e, session: AgentSession): void => saveAgentSession(session))
  ipcMain.handle('agent:sessionDelete', (_e, id: string): void => deleteAgentSession(id))

  ipcMain.handle('usage:list', (_e, limit?: number): UsageRecord[] => listUsage(limit ?? 200))
  ipcMain.handle('usage:stats', (): UsageStats => computeStats())

  ipcMain.handle(
    'pipeline:run',
    async (e: IpcMainInvokeEvent, action: PipelineAction, params: unknown): Promise<string> => {
      if (action === 'outline') {
        const p = params as OutlineGenParams
        return startStream(e.sender, buildOutlineRequest(p), {
          action,
          afterDone: (r) => applyOutlineResult(p, r.text)
        })
      }
      if (action === 'chapter') {
        const { outlineId } = params as { outlineId: string }
        const outline = store.getOutline(outlineId)
        if (!outline) throw new Error('章节不存在')
        const built = buildChapterRequest(outline.projectId, outlineId)
        return startStream(e.sender, built.params, {
          action,
          afterDone: (r) => {
            const chapter = store.saveChapter({
              outlineId,
              projectId: outline.projectId,
              content: r.text,
              status: 'draft'
            })
            return {
              chapterId: chapter.id,
              wordCount: chapter.wordCount,
              contextParts: built.ctx.parts,
              contextTokens: built.ctx.totalTokens
            }
          }
        })
      }
      if (action === 'summary') {
        const { outlineId, finalize } = params as { outlineId: string; finalize?: boolean }
        const outline = store.getOutline(outlineId)
        if (!outline) throw new Error('章节不存在')
        if (!store.getChapterByOutline(outlineId)) throw new Error('该章节还没有正文')
        if (finalize) {
          store.saveOutline({
            id: outlineId,
            projectId: outline.projectId,
            volume: outline.volume,
            chapterNo: outline.chapterNo,
            title: outline.title,
            synopsis: outline.synopsis,
            status: 'written'
          })
        }
        return startStream(e.sender, buildSummaryRequest(outline.projectId, outlineId), {
          action,
          afterDone: (r) => applySummaryResult(outline.projectId, outlineId, r.text)
        })
      }
      if (action === 'polish') {
        const { outlineId } = params as { outlineId: string }
        const outline = store.getOutline(outlineId)
        if (!outline) throw new Error('章节不存在')
        return startStream(e.sender, buildPolishRequest(outline.projectId, outlineId), {
          action,
          afterDone: (r) => ({ wordCount: r.text.replace(/\s/g, '').length })
        })
      }
      if (action === 'check') {
        const { outlineId } = params as { outlineId: string }
        const outline = store.getOutline(outlineId)
        if (!outline) throw new Error('章节不存在')
        return startStream(e.sender, buildCheckRequest(outline.projectId, outlineId), {
          action,
          afterDone: (r) => parseCheckResult(r.text)
        })
      }
      if (action === 'character') {
        const p = params as CharacterGenParams
        return startStream(e.sender, buildCharacterRequest(p.projectId, p.brief, p.allowUpdate === true), {
          action,
          afterDone: (r) => {
            const parsed = parseCharacterCards(r.text)
            let characterId: string | undefined
            let name = ''
            if (parsed.main) {
              name = guessCharacterName(parsed.main, p.name ?? '')
              const character = store.saveCharacter({
                projectId: p.projectId,
                name,
                tags: parsed.mainTags.join(','),
                card: parsed.main
              })
              characterId = character.id
            }
            const revised: Array<{ id: string; name: string }> = []
            if (parsed.revisions.length > 0) {
              const existing = store.listCharacters(p.projectId)
              for (const rev of parsed.revisions) {
                const hit = existing.find((c) => c.name.trim() === rev.name)
                if (!hit || !rev.card.trim()) continue
                store.saveCharacter({
                  id: hit.id,
                  projectId: p.projectId,
                  name: hit.name,
                  role: hit.role,
                  tags: rev.tags.length > 0 ? rev.tags.join(',') : hit.tags,
                  card: rev.card
                })
                revised.push({ id: hit.id, name: hit.name })
              }
            }
            return { characterId, name, revised }
          }
        })
      }
      if (action === 'worldbuild') {
        const p = params as WorldbuildGenParams
        const retrieval = await runWorldbuildRetrieval(p)
        return startStream(e.sender, buildWorldbuildRequest(p, retrieval), {
          action,
          afterDone: (r) => ({ entries: previewWorldbuildResult(p, r.text) }),
          continueOnMaxTokens: 3
        })
      }
      throw new Error(`未知动作: ${action}`)
    }
  )

  ipcMain.handle('novel:projects', (): Project[] => store.listProjects())
  ipcMain.handle('novel:projectCreate', (_e, input: ProjectInput): Project =>
    store.createProject(input)
  )
  ipcMain.handle(
    'novel:projectUpdate',
    (_e, id: string, input: Partial<ProjectInput>): void => store.updateProject(id, input)
  )
  ipcMain.handle('novel:projectDelete', (_e, id: string): void => store.deleteProject(id))
  ipcMain.handle('novel:characters', (_e, projectId: string): Character[] =>
    store.listCharacters(projectId)
  )
  ipcMain.handle('novel:characterSave', (_e, input: CharacterInput & { id?: string }): Character =>
    store.saveCharacter(input)
  )
  ipcMain.handle('novel:characterDelete', (_e, id: string): void => store.deleteCharacter(id))
  ipcMain.handle('novel:worldbuild', (_e, projectId: string): WorldbuildEntry[] =>
    store.listWorldbuild(projectId)
  )
  ipcMain.handle(
    'novel:worldbuildSave',
    (_e, input: WorldbuildInput & { id?: string }): WorldbuildEntry => store.saveWorldbuild(input)
  )
  ipcMain.handle('novel:worldbuildDelete', (_e, id: string): void => store.deleteWorldbuild(id))
  ipcMain.handle(
    'novel:worldbuildDeleteBatch',
    (_e, projectId: string, ids: string[]): number => store.deleteWorldbuildBatch(projectId, ids)
  )
  ipcMain.handle(
    'novel:worldbuildCommitChunk',
    (
      _e,
      projectId: string,
      rawText: string,
      categories: string[],
      opts: { allowNewType: boolean; taskEntryIds: string[]; allowUpdate?: boolean }
    ): { entryIds: string[]; createdTypes: string[]; updatedIds: string[]; revisedIds: string[] } =>
      commitWorldbuildChunk(projectId, rawText, categories, opts)
  )
  ipcMain.handle(
    'novel:worldbuildRelink',
    (_e, projectId: string, entryIds: string[]): number =>
      relinkWorldbuildEntries(projectId, entryIds)
  )
  ipcMain.handle(
    'novel:worldbuildRetrieve',
    async (_e, p: WorldbuildGenParams): Promise<{
      types: string[]
      tags: string[]
      count: number
      titles: string[]
    } | null> => {
      const retrieval = await runWorldbuildRetrieval(p)
      if (!retrieval || retrieval.entries.length === 0) return null
      return {
        types: retrieval.types,
        tags: retrieval.tags,
        count: retrieval.entries.length,
        titles: retrieval.entries.map((e) => e.title)
      }
    }
  )
  ipcMain.handle(
    'novel:worldbuildSaveBatch',
    (
      _e,
      projectId: string,
      entries: WorldbuildPreviewEntry[]
    ): { entryIds: string[]; createdTypes: string[] } => saveWorldbuildBatch(projectId, entries)
  )
  ipcMain.handle('novel:worldbuildTypes', (_e, projectId: string): string[] =>
    store.listWorldbuildTypes(projectId)
  )
  ipcMain.handle(
    'novel:worldbuildTypeCreate',
    (_e, projectId: string, name: string): string[] => {
      store.createWorldbuildType(projectId, name)
      return store.listWorldbuildTypes(projectId)
    }
  )
  ipcMain.handle(
    'novel:worldbuildTypeDelete',
    (_e, projectId: string, name: string): string[] => {
      store.deleteWorldbuildType(projectId, name)
      return store.listWorldbuildTypes(projectId)
    }
  )
  ipcMain.handle(
    'novel:worldbuildTypeReorder',
    (
      _e,
      projectId: string,
      name: string,
      pos: store.WorldbuildTypePos
    ): string[] => store.reorderWorldbuildType(projectId, name, pos)
  )
  ipcMain.handle('novel:outlines', (_e, projectId: string): OutlineItem[] =>
    store.listOutlines(projectId)
  )
  ipcMain.handle('novel:outlineSave', (_e, input: OutlineInput & { id?: string }): OutlineItem =>
    store.saveOutline(input)
  )
  ipcMain.handle('novel:outlineDelete', (_e, id: string): void => store.deleteOutline(id))
  ipcMain.handle('novel:chapterBriefs', (_e, projectId: string): ChapterBrief[] =>
    store.listChapterBriefs(projectId)
  )
  ipcMain.handle('novel:chapter', (_e, outlineId: string): Chapter | null =>
    store.getChapterByOutline(outlineId)
  )
  ipcMain.handle(
    'novel:saveChapter',
    (
      _e,
      input: { outlineId: string; projectId: string; content: string; status?: string }
    ): Chapter => store.saveChapter(input)
  )
  ipcMain.handle('novel:contextPreview', (_e, outlineId: string) => {
    const outline = store.getOutline(outlineId)
    if (!outline) throw new Error('章节不存在')
    return buildChapterContext(outline.projectId, outlineId)
  })
  ipcMain.handle('novel:foreshadows', (_e, projectId: string): Foreshadow[] =>
    store.listForeshadows(projectId)
  )
  ipcMain.handle(
    'novel:foreshadowSave',
    (_e, input: ForeshadowInput & { id?: string }): Foreshadow => store.saveForeshadow(input)
  )
  ipcMain.handle('novel:foreshadowDelete', (_e, id: string): void => store.deleteForeshadow(id))
  ipcMain.handle('novel:summary', (_e, outlineId: string): ChapterSummary | null => {
    const chapter = store.getChapterByOutline(outlineId)
    return chapter ? store.getSummary(chapter.id) : null
  })
  ipcMain.handle(
    'export:run',
    (
      _e,
      opts: { projectId: string; format: 'txt' | 'md' | 'docx'; scope: 'all' | 'single'; outlineId?: string }
    ) => exportProject(opts)
  )

  ipcMain.handle('graph:project', (_e, projectId: string): ProjectGraph =>
    buildProjectGraph(projectId)
  )

  ipcMain.handle('skills:list', (): SkillMeta[] => listSkills())
  ipcMain.handle('skills:get', (_e, filename: string): SkillFile | null => getSkill(filename))
  ipcMain.handle('skills:save', (_e, filename: string, raw: string): void =>
    saveSkill(filename, raw)
  )
  ipcMain.handle('skills:delete', (_e, filename: string): void => deleteSkill(filename))
}
