import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type {
  Chapter,
  ChapterBrief,
  Character,
  CharacterInput,
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
import { buildChapterContext } from './context'
import { chatStream, LlmError, pickRatelimitHeaders, probeModels } from './llm'
import {
  applyOutlineResult,
  applySummaryResult,
  buildChapterRequest,
  buildOutlineRequest,
  buildSummaryRequest
} from './pipeline'
import { getApiKey, getBaseUrl, getPromptCacheEnabled, loadSettingsView, saveSettings } from './settings'
import * as store from './store'
import { deleteSkill, getSkill, listSkills, saveSkill } from './skills'
import { appendUsage, computeStats, listUsage } from './usage'

const activeRequests = new Map<string, AbortController>()

function startStream(
  win: WebContents,
  rawParams: ChatParams,
  opts?: { action?: PipelineAction; afterDone?: (result: ChatResult) => unknown }
): string {
  const requestId = randomUUID()
  const controller = new AbortController()
  activeRequests.set(requestId, controller)

  void (async () => {
    try {
      const apiKey = await getApiKey()
      if (!apiKey) throw new Error('未配置 API Key，请先在设置中填写')
      const baseUrl = await getBaseUrl()
      const promptCache = await getPromptCacheEnabled()
      const params: ChatParams = { ...rawParams }
      if (!params.model) {
        const s = await loadSettingsView()
        params.model =
          (params.purpose && s.modelRouting[params.purpose]) || s.defaultModel
      }
      if (promptCache && params.system) params.cacheSystem = true

      const result = await chatStream(
        params,
        { apiKey, baseUrl },
        (text) => {
          if (!win.isDestroyed()) win.send('llm:delta', requestId, text)
        },
        controller.signal
      )

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

      let data: unknown
      let dataError: string | undefined
      try {
        data = opts?.afterDone?.(result)
      } catch (err) {
        dataError = (err as Error)?.message ?? String(err)
      }

      if (!win.isDestroyed()) {
        win.send('llm:done', requestId, {
          usage: result.usage,
          model: result.model,
          stopReason: result.stopReason,
          durationMs: result.durationMs,
          headers: result.headers,
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

export function registerIpc(): void {
  ipcMain.handle('settings:get', (): Promise<SettingsView> => loadSettingsView())
  ipcMain.handle('settings:save', (_e, patch: SettingsPatch): Promise<SettingsView> =>
    saveSettings(patch)
  )

  ipcMain.handle('models:probe', async (_e, apiKeyOverride?: string): Promise<ModelProbeResult> => {
    const apiKey = apiKeyOverride?.trim() || (await getApiKey())
    if (!apiKey) throw new Error('未配置 API Key')
    return probeModels({ apiKey, baseUrl: await getBaseUrl() })
  })

  ipcMain.handle('llm:chat', (e: IpcMainInvokeEvent, params: ChatParams): string =>
    startStream(e.sender, params)
  )

  ipcMain.handle('llm:abort', (_e, requestId: string): void => {
    activeRequests.get(requestId)?.abort()
  })

  ipcMain.handle('usage:list', (_e, limit?: number): UsageRecord[] => listUsage(limit ?? 200))
  ipcMain.handle('usage:stats', (): UsageStats => computeStats())

  ipcMain.handle(
    'pipeline:run',
    (e: IpcMainInvokeEvent, action: PipelineAction, params: unknown): string => {
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
        const { outlineId } = params as { outlineId: string }
        const outline = store.getOutline(outlineId)
        if (!outline) throw new Error('章节不存在')
        if (!store.getChapterByOutline(outlineId)) throw new Error('该章节还没有正文')
        store.saveOutline({
          id: outlineId,
          projectId: outline.projectId,
          volume: outline.volume,
          chapterNo: outline.chapterNo,
          title: outline.title,
          synopsis: outline.synopsis,
          status: 'written'
        })
        return startStream(e.sender, buildSummaryRequest(outline.projectId, outlineId), {
          action,
          afterDone: (r) => applySummaryResult(outline.projectId, outlineId, r.text)
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

  ipcMain.handle('skills:list', (): SkillMeta[] => listSkills())
  ipcMain.handle('skills:get', (_e, filename: string): SkillFile | null => getSkill(filename))
  ipcMain.handle('skills:save', (_e, filename: string, raw: string): void =>
    saveSkill(filename, raw)
  )
  ipcMain.handle('skills:delete', (_e, filename: string): void => deleteSkill(filename))
}
