export const PROVIDER_IDS = ['glm', 'deepseek', 'ollama', 'lmstudio', 'custom'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

/** LLM 端点协议：anthropic = /v1/messages，openai = /v1/chat/completions（llm.ts 内部转换，上层无感） */
export type Protocol = 'anthropic' | 'openai'

export interface ProviderPreset {
  id: ProviderId
  label: string
  /** 端点协议；custom 的实际协议可被 profile.protocol 覆盖，其余 provider 固定 */
  protocol: Protocol
  baseUrl: string
  defaultModel: string
  builtinModels: string[]
  needsKey: boolean
  supportsCache: boolean
  keyHint: string
  hint: string
  /** 该 provider 常规模型的上下文窗口（tokens），供智能体主动压缩预估；未知/混杂则省略，主进程回退保守默认值 */
  contextWindow?: number
}

/** 有效协议：custom 看 profile 覆盖（缺省 anthropic），其余用预设值 */
export function effectiveProtocol(id: ProviderId, profileProtocol?: Protocol): Protocol {
  return id === 'custom'
    ? profileProtocol === 'openai'
      ? 'openai'
      : 'anthropic'
    : providerPreset(id).protocol
}

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  glm: {
    id: 'glm',
    label: 'GLM',
    protocol: 'anthropic',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    defaultModel: 'glm-4.6',
    builtinModels: ['glm-5.3', 'glm-4.6', 'glm-4.5-air', 'glm-4.5'],
    needsKey: true,
    supportsCache: true,
    keyHint: '填入 GLM Coding Plan 的 API Key',
    hint: '密钥使用系统凭据库加密存储，仅保存在本机。获取：open.bigmodel.cn → API Keys',
    contextWindow: 200_000
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-flash',
    builtinModels: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    needsKey: true,
    supportsCache: false,
    keyHint: '填入 DeepSeek API Key',
    hint: '走官方 Anthropic 兼容端点（api.deepseek.com/anthropic），按量计费。获取：platform.deepseek.com → API Keys',
    contextWindow: 128_000
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama（本地）',
    protocol: 'anthropic',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'qwen3:14b',
    builtinModels: ['qwen3-coder', 'qwen3:14b', 'qwen3:30b-a3b', 'gpt-oss:20b'],
    needsKey: false,
    supportsCache: false,
    keyHint: '本地 Ollama 无需 API Key',
    hint: '需 Ollama v0.12+（提供 Anthropic /v1/messages 兼容）。先 ollama pull 模型；本地推理免费，但速度与工具调用质量取决于模型和显存',
    // 模型标称窗口，仅作上限估计：Ollama 运行时默认 num_ctx 常只有 4096/8192（需 Modelfile/环境变量调大），
    // 未调大时实际可用窗口远小于此值——主动压缩阈值据此估算会偏松（不触发），超限报错文案也未必命中
    // context_too_long 分类，最终退化为普通 run_error（与无压缩时的既有行为一致）
    contextWindow: 32_768
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio（本地）',
    protocol: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: '',
    builtinModels: [],
    needsKey: false,
    supportsCache: false,
    keyHint: '本地服务无需 API Key',
    hint: '任意 OpenAI 兼容本地端点（LM Studio / llama.cpp / vLLM 等，/v1/chat/completions）。先在服务端加载模型再点「探测可用模型」；想用 Ollama 走此协议可把地址改为 http://localhost:11434/v1',
    contextWindow: 32_768
  },
  custom: {
    id: 'custom',
    label: '自定义',
    protocol: 'anthropic',
    baseUrl: '',
    defaultModel: '',
    builtinModels: [],
    needsKey: false,
    supportsCache: true,
    keyHint: '按网关要求填写，可留空',
    hint: 'Anthropic 或 OpenAI 兼容端点：选协议后填 baseUrl 与模型名；Anthropic 协议下启用缓存需端点支持 cache_control'
  }
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

export function providerPreset(id: ProviderId): ProviderPreset {
  return PROVIDER_PRESETS[id]
}
