import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  Character,
  CharacterInput,
  ChatParams,
  ModelProbeResult,
  OutlineInput,
  OutlineItem,
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
import { chatStream, LlmError, pickRatelimitHeaders, probeModels } from './llm'
import { getApiKey, getBaseUrl, getPromptCacheEnabled, loadSettingsView, saveSettings } from './settings'
import { appendUsage, computeStats, listUsage } from './usage'
import { deleteSkill, getSkill, listSkills, saveSkill } from './skills'
import * as store from './store'

const activeRequests = new Map<string, AbortController>()

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

  ipcMain.handle('llm:chat', async (e: IpcMainInvokeEvent, params: ChatParams): Promise<string> => {
    const apiKey = await getApiKey()
    if (!apiKey) throw new Error('未配置 API Key，请先在设置中填写')
    const baseUrl = await getBaseUrl()
    const promptCache = await getPromptCacheEnabled()
    if (promptCache && params.system) params.cacheSystem = true

    const requestId = randomUUID()
    const controller = new AbortController()
    activeRequests.set(requestId, controller)
    const win = e.sender

    chatStream(
      params,
      { apiKey, baseUrl },
      (text) => {
        if (!win.isDestroyed()) win.send('llm:delta', requestId, text)
      },
      controller.signal
    )
      .then((result) => {
        const record: UsageRecord = {
          ts: Date.now(),
          model: result.model,
          purpose: params.purpose ?? 'playground',
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheCreationTokens: result.usage.cacheCreationTokens,
          durationMs: result.durationMs,
          ratelimit: pickRatelimitHeaders(result.headers)
        }
        appendUsage(record)
        if (!win.isDestroyed()) {
          win.send('llm:done', requestId, {
            usage: result.usage,
            model: result.model,
            stopReason: result.stopReason,
            durationMs: result.durationMs,
            headers: result.headers
          })
        }
      })
      .catch((err: unknown) => {
        if (!win.isDestroyed()) {
          const message =
            err instanceof LlmError
              ? `[${err.status ?? '网络'}] ${err.message}`
              : ((err as Error)?.message ?? String(err))
          win.send('llm:error', requestId, message)
        }
      })
      .finally(() => {
        activeRequests.delete(requestId)
      })

    return requestId
  })

  ipcMain.handle('llm:abort', (_e, requestId: string): void => {
    activeRequests.get(requestId)?.abort()
  })

  ipcMain.handle('usage:list', (_e, limit?: number): UsageRecord[] => listUsage(limit ?? 200))
  ipcMain.handle('usage:stats', (): UsageStats => computeStats())

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

  ipcMain.handle('skills:list', (): SkillMeta[] => listSkills())
  ipcMain.handle('skills:get', (_e, filename: string): SkillFile | null => getSkill(filename))
  ipcMain.handle('skills:save', (_e, filename: string, raw: string): void =>
    saveSkill(filename, raw)
  )
  ipcMain.handle('skills:delete', (_e, filename: string): void => deleteSkill(filename))
}
