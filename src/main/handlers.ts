import { randomUUID } from 'node:crypto'
import type {
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
  ServerStatus,
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
import { LONG_CHAPTER_THRESHOLD, runLongChapter } from './chapterRunner'
import { buildChapterContext } from './context'
import type { EventSink } from './eventSink'
import { buildProjectGraph } from './graph'
import { chatStream, LlmError, pickRatelimitHeaders, probeModels } from './llm'
import { lintChapterReport, stripHtmlComments } from './lint'
import { providerPreset } from '../shared/providers'
import {
  applyOutlineResult,
  applyStateSyncResult,
  applySummaryResult,
  applyVolumeSummaryResult,
  buildChapterRequest,
  buildCharacterRequest,
  buildCheckRequest,
  buildExpandRequest,
  buildOutlineRequest,
  buildPolishRequest,
  buildReviewRequest,
  buildStateSyncRequest,
  buildSummaryRequest,
  buildVolumeSummaryRequest,
  buildWorldbuildIndex,
  buildWorldbuildRequest,
  buildWorldbuildRetrieveRequest,
  commitWorldbuildChunk,
  guessCharacterName,
  parseCharacterCards,
  parseCheckResult,
  parseReviewResult,
  previewWorldbuildResult,
  relinkWorldbuildEntries,
  resolveWorldbuildRetrieval,
  saveWorldbuildBatch,
  type WorldbuildRetrieval
} from './pipeline'
import {
  deleteEmbeddings,
  deleteEmbeddingsByRef,
  enqueueEmbedding,
  getEmbeddingStatus,
  rebuildEmbeddings,
  semanticSearch,
  setEmbeddingEnabled
} from './embedding'
import type { SearchHit } from '../shared/types'
import { getApiKeyFor, loadSettingsView, resolveRequestAuth, saveSettings } from './settings'
import { getServerStatus } from './serverState'
import * as store from './store'
import { deleteSkill, getSkill, listSkills, saveSkill } from './skills'
import { appendUsage, computeStats, listUsage } from './usage'

/**
 * 所有 handler 的第一个参数是传输上下文：Electron 里包装 WebContents，
 * HTTP 里推送到 SSE。除流式接口外通常不使用。
 */
export interface HandlerContext {
  sink: EventSink
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (ctx: HandlerContext, ...args: any[]) => unknown

const activeRequests = new Map<string, AbortController>()
const activeAgentRuns = new Map<string, AbortController>()

function startAgentRun(
  sink: EventSink,
  params: { projectId: string; messages: ChatMessage[]; model?: string }
): string {
  const requestId = randomUUID()
  const controller = new AbortController()
  activeAgentRuns.set(requestId, controller)

  void (async () => {
    let payload: Awaited<ReturnType<typeof runAgent>>
    try {
      const auth = await resolveRequestAuth('agent')
      payload = await runAgent({
        sink,
        requestId,
        projectId: params.projectId,
        messages: params.messages,
        model: params.model?.trim() || auth.model,
        signal: controller.signal
      })
    } catch (err) {
      if (!sink.isClosed()) {
        const message = controller.signal.aborted
          ? '已停止'
          : ((err as Error)?.message ?? String(err))
        sink.send('agent:error', requestId, message)
      }
      return
    } finally {
      activeAgentRuns.delete(requestId)
    }
    if (!sink.isClosed()) sink.send('agent:done', requestId, payload)
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
  sink: EventSink,
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
      const auth = await resolveRequestAuth(rawParams.purpose)
      if (!auth.apiKey && auth.needsKey) throw new Error('未配置 API Key，请先在设置中填写')
      const params: ChatParams = { ...rawParams }
      if (!params.model) params.model = auth.model
      if (auth.fallbackReason && !sink.isClosed()) {
        sink.send('llm:notice', requestId, auth.fallbackReason)
      }
      if (auth.promptCache && params.system) params.cacheSystem = true

      const send = (text: string): void => {
        if (!sink.isClosed()) sink.send('llm:delta', requestId, text)
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

      if (!sink.isClosed()) {
        sink.send('llm:done', requestId, {
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
      if (!sink.isClosed()) {
        const message =
          err instanceof LlmError
            ? `[${err.status ?? '网络'}] ${err.message}`
            : ((err as Error)?.message ?? String(err))
        sink.send('llm:error', requestId, message)
      }
    } finally {
      activeRequests.delete(requestId)
    }
  })()

  return requestId
}

/** 长章模式（AgentWrite 计划→逐段写）：多请求编排，对外仍是单 requestId 流 */
function startLongChapterStream(
  sink: EventSink,
  projectId: string,
  outlineId: string,
  wordTarget: number
): string {
  const requestId = randomUUID()
  const controller = new AbortController()
  activeRequests.set(requestId, controller)

  void (async () => {
    try {
      const started = Date.now()
      const result = await runLongChapter({
        sink,
        requestId,
        projectId,
        outlineId,
        wordTarget,
        signal: controller.signal
      })
      const clean = stripHtmlComments(result.text)
      const chapter = store.saveChapter({
        outlineId,
        projectId,
        content: clean,
        status: 'draft'
      })
      enqueueEmbedding(projectId, 'summary', outlineId, clean.slice(0, 1200))
      if (!sink.isClosed()) {
        sink.send('llm:done', requestId, {
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          model: '',
          stopReason: 'end_turn',
          durationMs: Date.now() - started,
          headers: {},
          action: 'chapter' as PipelineAction,
          data: {
            chapterId: chapter.id,
            wordCount: chapter.wordCount,
            longMode: true,
            segments: result.plan.length,
            lint: lintChapterReport(outlineId, clean)
          }
        })
      }
    } catch (err) {
      if (!sink.isClosed()) {
        const message = controller.signal.aborted
          ? '已停止'
          : err instanceof LlmError
            ? `[${err.status ?? '网络'}] ${err.message}`
            : ((err as Error)?.message ?? String(err))
        sink.send('llm:error', requestId, message)
      }
    } finally {
      activeRequests.delete(requestId)
    }
  })()

  return requestId
}

async function runWorldbuildRetrieval(p: WorldbuildGenParams): Promise<WorldbuildRetrieval | undefined> {  const req = buildWorldbuildRetrieveRequest(p)
  if (!req) return undefined
  try {
    const auth = await resolveRequestAuth(req.purpose)
    if (!auth.apiKey && auth.needsKey) return undefined
    const params: ChatParams = { ...req, model: req.model || auth.model }
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

/** 同时供 Electron IPC 与内嵌 HTTP 服务调用。 */
export const sharedHandlers: Record<string, Handler> = {
  'settings:get': (): Promise<SettingsView> => loadSettingsView(),
  'settings:save': (_ctx, patch: SettingsPatch): Promise<SettingsView> => saveSettings(patch),

  'server:status': (): ServerStatus => getServerStatus(),

  'models:probe': async (_ctx, opts?: ModelProbeOptions): Promise<ModelProbeResult> => {
    const view = await loadSettingsView()
    const provider = opts?.provider ?? view.provider
    const providerView = view.profiles[provider]
    const apiKey = opts?.apiKey?.trim() || (await getApiKeyFor(provider))
    const baseUrl = opts?.baseUrl?.trim() || providerView.baseUrl
    if (!apiKey && providerPreset(provider).needsKey) throw new Error('未配置 API Key')
    return probeModels({ provider, apiKey, baseUrl })
  },

  'llm:chat': (ctx, params: ChatParams): string => startStream(ctx.sink, params),

  'llm:abort': (_ctx, requestId: string): void => {
    activeRequests.get(requestId)?.abort()
  },

  'agent:run': (
    ctx,
    params: { projectId: string; messages: ChatMessage[]; model?: string }
  ): string => startAgentRun(ctx.sink, params),
  'agent:abort': (_ctx, requestId: string): void => {
    activeAgentRuns.get(requestId)?.abort()
    cancelAgentConfirms(requestId)
  },
  'agent:resolve': (
    _ctx,
    requestId: string,
    confirmId: string,
    allow: boolean,
    always?: boolean
  ): boolean => resolveAgentConfirm(requestId, confirmId, allow, !!always),
  'agent:sessions': (_ctx, projectId?: string): AgentSessionBrief[] =>
    listAgentSessions(projectId),
  'agent:sessionLoad': (_ctx, id: string): AgentSession | null => loadAgentSession(id),
  'agent:sessionSave': (_ctx, session: AgentSession): void => saveAgentSession(session),
  'agent:sessionDelete': (_ctx, id: string): void => deleteAgentSession(id),

  'usage:list': (_ctx, limit?: number): UsageRecord[] => listUsage(limit ?? 200),
  'usage:stats': (): UsageStats => computeStats(),

  'pipeline:run': async (ctx, action: PipelineAction, params: unknown): Promise<string> => {
    if (action === 'outline') {
      const p = params as OutlineGenParams
      return startStream(ctx.sink, buildOutlineRequest(p), {
        action,
        afterDone: (r) => applyOutlineResult(p, r.text)
      })
    }
    if (action === 'chapter') {
      const { outlineId, wordTarget } = params as { outlineId: string; wordTarget?: number }
      const outline = store.getOutline(outlineId)
      if (!outline) throw new Error('章节不存在')
      if (wordTarget && wordTarget >= LONG_CHAPTER_THRESHOLD) {
        return startLongChapterStream(ctx.sink, outline.projectId, outlineId, wordTarget)
      }
      const built = await buildChapterRequest(outline.projectId, outlineId, wordTarget)
      return startStream(ctx.sink, built.params, {
        action,
        afterDone: (r) => {
          const clean = stripHtmlComments(r.text)
          const chapter = store.saveChapter({
            outlineId,
            projectId: outline.projectId,
            content: clean,
            status: 'draft'
          })
          enqueueEmbedding(outline.projectId, 'summary', outlineId, clean.slice(0, 1200))
          return {
            chapterId: chapter.id,
            wordCount: chapter.wordCount,
            contextParts: built.ctx.parts,
            contextTokens: built.ctx.totalTokens,
            lint: lintChapterReport(outlineId, clean)
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
      return startStream(ctx.sink, buildSummaryRequest(outline.projectId, outlineId), {
        action,
        afterDone: (r) => applySummaryResult(outline.projectId, outlineId, r.text)
      })
    }
    if (action === 'polish') {
      const { outlineId } = params as { outlineId: string }
      const outline = store.getOutline(outlineId)
      if (!outline) throw new Error('章节不存在')
      return startStream(ctx.sink, buildPolishRequest(outline.projectId, outlineId), {
        action,
        afterDone: (r) => ({ wordCount: r.text.replace(/\s/g, '').length })
      })
    }
    if (action === 'check') {
      const { outlineId } = params as { outlineId: string }
      const outline = store.getOutline(outlineId)
      if (!outline) throw new Error('章节不存在')
      return startStream(ctx.sink, await buildCheckRequest(outline.projectId, outlineId), {
        action,
        afterDone: (r) => parseCheckResult(r.text)
      })
    }
    if (action === 'review') {
      const { outlineId } = params as { outlineId: string }
      const outline = store.getOutline(outlineId)
      if (!outline) throw new Error('章节不存在')
      return startStream(ctx.sink, await buildReviewRequest(outline.projectId, outlineId), {
        action,
        afterDone: (r) => parseReviewResult(r.text).result
      })
    }
    if (action === 'expand') {
      const { outlineId, targetWords } = params as { outlineId: string; targetWords: number }
      const outline = store.getOutline(outlineId)
      if (!outline) throw new Error('章节不存在')
      if (!targetWords || targetWords < 500) throw new Error('目标字数无效')
      return startStream(ctx.sink, buildExpandRequest(outline.projectId, outlineId, targetWords), {
        action,
        afterDone: (r) => ({ wordCount: r.text.replace(/\s/g, '').length }),
        continueOnMaxTokens: 2
      })
    }
    if (action === 'volumeSummary') {
      const { projectId, volume } = params as { projectId: string; volume: number }
      return startStream(ctx.sink, buildVolumeSummaryRequest(projectId, volume), {
        action,
        afterDone: (r) => applyVolumeSummaryResult(projectId, volume, r.text)
      })
    }
    if (action === 'stateSync') {
      const { outlineId } = params as { outlineId: string }
      const outline = store.getOutline(outlineId)
      if (!outline) throw new Error('章节不存在')
      return startStream(ctx.sink, buildStateSyncRequest(outline.projectId, outlineId), {
        action,
        afterDone: (r) => applyStateSyncResult(outline.projectId, r.text)
      })
    }
    if (action === 'character') {
      const p = params as CharacterGenParams
      return startStream(ctx.sink, buildCharacterRequest(p.projectId, p.brief, p.allowUpdate === true), {
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
      return startStream(ctx.sink, buildWorldbuildRequest(p, retrieval), {
        action,
        afterDone: (r) => ({ entries: previewWorldbuildResult(p, r.text) }),
        continueOnMaxTokens: 3
      })
    }
    throw new Error(`未知动作: ${action}`)
  },

  'novel:projects': (): Project[] => store.listProjects(),
  'novel:projectCreate': (_ctx, input: ProjectInput): Project => store.createProject(input),
  'novel:projectUpdate': (_ctx, id: string, input: Partial<ProjectInput>): void =>
    store.updateProject(id, input),
  'novel:projectDelete': (_ctx, id: string): void => store.deleteProject(id),
  'novel:characters': (_ctx, projectId: string): Character[] => store.listCharacters(projectId),
  'novel:characterSave': (_ctx, input: CharacterInput & { id?: string }): Character => {
    const saved = store.saveCharacter(input)
    enqueueEmbedding(saved.projectId, 'character', saved.id, `${saved.name} ${saved.role} ${saved.tags} ${saved.card}`)
    return saved
  },
  'novel:characterDelete': (_ctx, id: string): void => {
    deleteEmbeddingsByRef('character', id)
    store.deleteCharacter(id)
  },
  'novel:worldbuild': (_ctx, projectId: string): WorldbuildEntry[] =>
    store.listWorldbuild(projectId),
  'novel:worldbuildSave': (_ctx, input: WorldbuildInput & { id?: string }): WorldbuildEntry => {
    const saved = store.saveWorldbuild(input)
    enqueueEmbedding(saved.projectId, 'worldbuild', saved.id, `${saved.title} ${saved.keys} ${saved.tags} ${saved.content}`)
    return saved
  },
  'novel:worldbuildDelete': (_ctx, id: string): void => {
    deleteEmbeddingsByRef('worldbuild', id)
    store.deleteWorldbuild(id)
  },
  'novel:worldbuildDeleteBatch': (_ctx, projectId: string, ids: string[]): number => {
    for (const id of ids) deleteEmbeddingsByRef('worldbuild', id)
    return store.deleteWorldbuildBatch(projectId, ids)
  },
  'novel:worldbuildCommitChunk': (
    _ctx,
    projectId: string,
    rawText: string,
    categories: string[],
    opts: { allowNewType: boolean; taskEntryIds: string[]; allowUpdate?: boolean }
  ): { entryIds: string[]; createdTypes: string[]; updatedIds: string[]; revisedIds: string[] } =>
    commitWorldbuildChunk(projectId, rawText, categories, opts),
  'novel:worldbuildRelink': (_ctx, projectId: string, entryIds: string[]): number =>
    relinkWorldbuildEntries(projectId, entryIds),
  'novel:worldbuildRetrieve': async (
    _ctx,
    p: WorldbuildGenParams
  ): Promise<{ types: string[]; tags: string[]; count: number; titles: string[] } | null> => {
    const retrieval = await runWorldbuildRetrieval(p)
    if (!retrieval || retrieval.entries.length === 0) return null
    return {
      types: retrieval.types,
      tags: retrieval.tags,
      count: retrieval.entries.length,
      titles: retrieval.entries.map((e) => e.title)
    }
  },
  'novel:worldbuildSaveBatch': (
    _ctx,
    projectId: string,
    entries: WorldbuildPreviewEntry[]
  ): { entryIds: string[]; createdTypes: string[] } => saveWorldbuildBatch(projectId, entries),
  'novel:worldbuildTypes': (_ctx, projectId: string): string[] =>
    store.listWorldbuildTypes(projectId),
  'novel:worldbuildTypeCreate': (_ctx, projectId: string, name: string): string[] => {
    store.createWorldbuildType(projectId, name)
    return store.listWorldbuildTypes(projectId)
  },
  'novel:worldbuildTypeDelete': (_ctx, projectId: string, name: string): string[] => {
    store.deleteWorldbuildType(projectId, name)
    return store.listWorldbuildTypes(projectId)
  },
  'novel:worldbuildTypeReorder': (
    _ctx,
    projectId: string,
    name: string,
    pos: store.WorldbuildTypePos
  ): string[] => store.reorderWorldbuildType(projectId, name, pos),
  'novel:outlines': (_ctx, projectId: string): OutlineItem[] => store.listOutlines(projectId),
  'novel:outlineSave': (_ctx, input: OutlineInput & { id?: string }): OutlineItem =>
    store.saveOutline(input),
  'novel:outlineDelete': (_ctx, id: string): void => store.deleteOutline(id),
  'novel:chapterBriefs': (_ctx, projectId: string): ChapterBrief[] =>
    store.listChapterBriefs(projectId),
  'novel:chapter': (_ctx, outlineId: string): Chapter | null =>
    store.getChapterByOutline(outlineId),
  'novel:saveChapter': (
    _ctx,
    input: { outlineId: string; projectId: string; content: string; status?: string }
  ): Chapter => store.saveChapter(input),
  'novel:contextPreview': (_ctx, outlineId: string) => {
    const outline = store.getOutline(outlineId)
    if (!outline) throw new Error('章节不存在')
    return buildChapterContext(outline.projectId, outlineId)
  },
  'novel:foreshadows': (_ctx, projectId: string): Foreshadow[] =>
    store.listForeshadows(projectId),
  'novel:foreshadowSave': (_ctx, input: ForeshadowInput & { id?: string }): Foreshadow =>
    store.saveForeshadow(input),
  'novel:foreshadowDelete': (_ctx, id: string): void => store.deleteForeshadow(id),
  'novel:summary': (_ctx, outlineId: string): ChapterSummary | null => {
    const chapter = store.getChapterByOutline(outlineId)
    return chapter ? store.getSummary(chapter.id) : null
  },
  'novel:volumeSummary': (_ctx, projectId: string, volume: number) =>
    store.getVolumeSummary(projectId, volume),
  'novel:volumeSummaries': (_ctx, projectId: string) => store.listVolumeSummaries(projectId),

  'lint:run': (_ctx, outlineId: string, text?: string) => lintChapterReport(outlineId, text),

  'embedding:status': (_ctx, projectId?: string) => getEmbeddingStatus(projectId),
  'embedding:setEnabled': (_ctx, enabled: boolean): void => setEmbeddingEnabled(enabled),
  'embedding:rebuild': async (_ctx, projectId?: string): Promise<{ count: number }> => ({
    count: await rebuildEmbeddings(projectId)
  }),

  'search:project': async (_ctx, projectId: string, query: string, limit?: number): Promise<SearchHit[]> => {
    const k = Math.min(20, Math.max(1, limit ?? 8))
    const hits = await semanticSearch(projectId, query, ['worldbuild', 'character', 'summary'], k)
    const wb = new Map(store.listWorldbuild(projectId).map((e) => [e.id, e]))
    const ch = new Map(store.listCharacters(projectId).map((c) => [c.id, c]))
    const ol = new Map(store.listOutlines(projectId).map((o) => [o.id, o]))
    const out: SearchHit[] = []
    for (const h of hits) {
      if (h.kind === 'worldbuild') {
        const e = wb.get(h.refId)
        if (e) out.push({ kind: 'worldbuild', id: e.id, title: `[${e.category}] ${e.title}`, snippet: e.content.slice(0, 160), score: h.score })
      } else if (h.kind === 'character') {
        const c = ch.get(h.refId)
        if (c) out.push({ kind: 'character', id: c.id, title: `${c.name}（${c.role || '未定位'}）`, snippet: c.card.slice(0, 160), score: h.score })
      } else if (h.kind === 'summary') {
        const o = ol.get(h.refId)
        const chapter = o ? store.getChapterByOutline(o.id) : null
        const s = chapter ? store.getSummary(chapter.id) : null
        if (o && s) out.push({ kind: 'chapter', id: o.id, title: `第${o.chapterNo}章 ${o.title}`, snippet: s.summary.slice(0, 160), score: h.score })
      }
    }
    return out
  },

  'graph:project': (_ctx, projectId: string): ProjectGraph => buildProjectGraph(projectId),

  'skills:list': (): SkillMeta[] => listSkills(),
  'skills:get': (_ctx, filename: string): SkillFile | null => getSkill(filename),
  'skills:save': (_ctx, filename: string, raw: string): void => saveSkill(filename, raw),
  'skills:delete': (_ctx, filename: string): void => deleteSkill(filename)
}

/** 仅 Electron IPC 可用（不暴露给局域网 HTTP），用于服务器自身配置等敏感操作。 */
export const ipcOnlyHandlers: Record<string, Handler> = {}
