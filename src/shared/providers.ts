/**
 * v2 模型接入：统一 OpenAI 兼容协议（/v1/chat/completions）。
 * 预设只留 glm / deepseek；任意其他端点（含本地 Ollama / LM Studio）走 custom。
 */

export const PROVIDER_IDS = ['glm', 'deepseek', 'custom'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export interface ProviderPreset {
  id: ProviderId
  label: string
  /** OpenAI 兼容 baseUrl（不带 /chat/completions；结尾无版本段时自动补 /v1） */
  baseUrl: string
  defaultModel: string
  builtinModels: string[]
  needsKey: boolean
  keyHint: string
  hint: string
  /** 该 provider 常规模型的上下文窗口（tokens），供上下文装配与主动压缩预估 */
  contextWindow?: number
  /** 该 provider 单次请求可用的最大输出 tokens */
  maxOutputTokens?: number
}

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  glm: {
    id: 'glm',
    label: 'GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.6',
    builtinModels: ['glm-5.3', 'glm-4.6', 'glm-4.5-air', 'glm-4.5'],
    needsKey: true,
    keyHint: '填入 GLM 的 API Key',
    hint: '走官方 OpenAI 兼容端点（open.bigmodel.cn/api/paas/v4），按量计费。获取：open.bigmodel.cn → API Keys',
    contextWindow: 200_000,
    maxOutputTokens: 16384
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    builtinModels: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    needsKey: true,
    keyHint: '填入 DeepSeek API Key',
    hint: '走官方 OpenAI 兼容端点（api.deepseek.com），按量计费。获取：platform.deepseek.com → API Keys',
    contextWindow: 128_000,
    maxOutputTokens: 8192
  },
  custom: {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    defaultModel: '',
    builtinModels: [],
    needsKey: false,
    keyHint: '按网关要求填写，可留空',
    hint: '任意 OpenAI 兼容端点：填 baseUrl（如 http://localhost:11434/v1 接本地 Ollama）与模型名。先用「探测可用模型」确认端点可用'
  }
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

export function providerPreset(id: ProviderId): ProviderPreset {
  return PROVIDER_PRESETS[id]
}

/** 模型路由四槽：导演（默认主槽）/正文/评审/工具。未配置的槽回退 director。 */
export const MODEL_SLOTS = ['director', 'writer', 'reviewer', 'utility'] as const
export type ModelSlot = (typeof MODEL_SLOTS)[number]

export function isModelSlot(value: unknown): value is ModelSlot {
  return typeof value === 'string' && (MODEL_SLOTS as readonly string[]).includes(value)
}
