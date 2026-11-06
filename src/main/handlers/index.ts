import { createRequire } from 'node:module'
import type { ChatParams } from '../../shared/contract.js'
import { providerPreset } from '../../shared/providers.js'
import { apiKey, profile, resolveAuth, saveSettings, viewSettings } from '../config.js'
import { chatStream, pickRatelimitHeaders, probeModels } from '../llm.js'
import { dataDir } from '../paths.js'
import { abortRun, pollRuns, startStreaming } from '../runs.js'
import { getServerStatus } from '../serverState.js'
import { appendUsage, computeStats, listUsage } from '../usage.js'
import { bookHandlers } from './books.js'
import { jobHandlers } from './jobs.js'
import { onboardHandlers } from './onboard.js'
import { sampleHandlers } from './samples.js'
import type { HandlerTable } from './types.js'

const require_ = createRequire(import.meta.url)
// src/main/handlers 与 dist/main/handlers 层级一致，../../../ 回项目根
const pkg = require_('../../../package.json') as { version: string }

const startedAt = Date.now()

// ── app / server ─────────────────────────────────────────────────────────────

const appHandlers: Pick<HandlerTable, 'app:info' | 'server:status'> = {
  'app:info': () => ({
    version: pkg.version,
    dataDir: dataDir(),
    uptimeS: Math.floor((Date.now() - startedAt) / 1000),
    platform: `${process.platform} node ${process.versions.node}`
  }),
  'server:status': () => getServerStatus()
}

// ── settings / models ────────────────────────────────────────────────────────

const settingsHandlers: Pick<HandlerTable, 'settings:get' | 'settings:save' | 'models:probe'> = {
  'settings:get': () => viewSettings(),
  'settings:save': (_ctx, [patch]) => saveSettings(patch),
  'models:probe': async (_ctx, [opts]) => {
    const provider = opts?.provider ?? viewSettings().provider
    const p = profile(provider)
    const key = opts?.apiKey || apiKey(provider)
    const baseUrl = opts?.baseUrl || p.baseUrl || providerPreset(provider).baseUrl
    return probeModels({ provider, apiKey: key, baseUrl })
  }
}

// ── llm 流式 ─────────────────────────────────────────────────────────────────

const llmHandlers: Pick<HandlerTable, 'llm:chat' | 'llm:abort' | 'llm:poll'> = {
  'llm:chat': (ctx, [params]) =>
    startStreaming(ctx.sink, (requestId, onDelta, signal) =>
      runChat(requestId, params, onDelta, signal)
    ),
  'llm:abort': (_ctx, [requestId]) => abortRun(requestId),
  'llm:poll': (_ctx, [{ requestIds }]) => pollRuns(requestIds)
}

async function runChat(
  requestId: string,
  params: ChatParams,
  onDelta: (t: string) => void,
  signal: AbortSignal
) {
  void requestId
  let auth = resolveAuth(params.slot ?? 'director')
  if (params.provider) {
    auth = {
      ...auth,
      provider: params.provider,
      apiKey: params.apiKeyOverride || apiKey(params.provider),
      baseUrl: profile(params.provider).baseUrl || providerPreset(params.provider).baseUrl,
      model: params.model || profile(params.provider).defaultModel,
      contextWindow: providerPreset(params.provider).contextWindow,
      maxOutputTokens: providerPreset(params.provider).maxOutputTokens
    }
  }
  if (params.model) auth.model = params.model
  const result = await chatStream(
    { ...params, model: auth.model },
    { apiKey: auth.apiKey, baseUrl: auth.baseUrl },
    { onDelta },
    signal
  )
  appendUsage({
    ts: Date.now(),
    model: result.model,
    purpose: params.slot ?? 'director',
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheCreationTokens: result.usage.cacheCreationTokens,
    durationMs: result.durationMs,
    ratelimit: pickRatelimitHeaders(result.headers)
  })
  return {
    text: result.text,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    model: result.model,
    stopReason: result.stopReason,
    durationMs: result.durationMs
  }
}

// ── usage ────────────────────────────────────────────────────────────────────

const usageHandlers: Pick<HandlerTable, 'usage:list' | 'usage:stats'> = {
  'usage:list': (_ctx, [limit]) => listUsage(limit),
  'usage:stats': () => computeStats()
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────

export const sharedHandlers: HandlerTable = {
  ...appHandlers,
  ...settingsHandlers,
  ...llmHandlers,
  ...usageHandlers,
  ...bookHandlers,
  ...jobHandlers,
  ...onboardHandlers,
  ...sampleHandlers
}

export function appVersion(): string {
  return pkg.version
}
