export const PROVIDER_IDS = ['glm', 'deepseek', 'ollama', 'custom'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export interface ProviderPreset {
  id: ProviderId
  label: string
  baseUrl: string
  defaultModel: string
  builtinModels: string[]
  needsKey: boolean
  supportsCache: boolean
  keyHint: string
  hint: string
}

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  glm: {
    id: 'glm',
    label: 'GLM',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    defaultModel: 'glm-4.6',
    builtinModels: ['glm-5.3', 'glm-4.6', 'glm-4.5-air', 'glm-4.5'],
    needsKey: true,
    supportsCache: true,
    keyHint: '填入 GLM Coding Plan 的 API Key',
    hint: '密钥使用系统凭据库加密存储，仅保存在本机。获取：open.bigmodel.cn → API Keys'
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-flash',
    builtinModels: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    needsKey: true,
    supportsCache: false,
    keyHint: '填入 DeepSeek API Key',
    hint: '走官方 Anthropic 兼容端点（api.deepseek.com/anthropic），按量计费。获取：platform.deepseek.com → API Keys'
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'qwen3:14b',
    builtinModels: ['qwen3-coder', 'qwen3:14b', 'gpt-oss:20b', 'glm-4.7:cloud'],
    needsKey: false,
    supportsCache: false,
    keyHint: '本地 Ollama 无需 API Key',
    hint: '需 Ollama v0.12+（提供 Anthropic /v1/messages 兼容）。先 ollama pull 模型；本地推理免费，但速度与工具调用质量取决于模型和显存'
  },
  custom: {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    defaultModel: '',
    builtinModels: [],
    needsKey: false,
    supportsCache: true,
    keyHint: '按网关要求填写，可留空',
    hint: '任意 Anthropic 兼容端点：自行填写 baseUrl 与模型名；启用缓存需端点支持 cache_control'
  }
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

export function providerPreset(id: ProviderId): ProviderPreset {
  return PROVIDER_PRESETS[id]
}
