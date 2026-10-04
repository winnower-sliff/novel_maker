// LLM 服务商错误分类：纯函数 + 关键词表，主进程发错误事件时附加 hint，
// 渲染端 invoke 拒绝（无 hint 结构）时用同一函数从 message 反推，两端共用单一匹配表。
import type { LlmErrorCategory, LlmErrorHint } from './types'

/** 各分类的友好提示文案（unknown 为空串：原样展示 raw，不画蛇添足） */
export const LLM_ERROR_FRIENDLY: Record<LlmErrorCategory, string> = {
  insufficient_balance: '模型服务商账户余额不足，请前往服务商充值，或在设置中切换其他模型服务。',
  auth: 'API Key 无效或未授权，请到设置页检查 API Key 是否正确、是否有权限访问该模型。',
  rate_limit: '请求过于频繁或超出调用配额，请稍等片刻再试。',
  model_not_found: '模型不存在或当前账户无权访问，请检查模型名称，或在设置页重新探测模型列表。',
  context_too_long: '输入内容超出模型的上下文长度限制，请缩短内容，或改用长上下文模型。',
  network: '网络请求失败，请检查本机网络与服务地址（baseUrl）配置；本地模型请确认服务已启动。',
  server_error: '模型服务商服务暂时异常，请稍后重试。',
  content_filter: '内容被服务商安全策略拦截，请调整相关内容表述后重试。',
  unknown: ''
}

/** 关键词规则：按序匹配，先命中先归类（具体类别在前，宽泛类别在后） */
const KEYWORD_RULES: ReadonlyArray<{ category: LlmErrorCategory; pattern: RegExp }> = [
  {
    category: 'insufficient_balance',
    pattern:
      /insufficient\s*(balance|quota|credit)|余额不足|欠费|quota\s*(exceeded|has been exceeded)|exceeded\s+your\s+current\s+quota|billing/i
  },
  {
    category: 'auth',
    pattern:
      /invalid[ _-]?(api[ _-]?)?key|incorrect\s+api\s+key|unauthorized|authentication(\s+error)?|鉴权失败|令牌无效|api\s*key/i
  },
  {
    category: 'rate_limit',
    pattern: /rate[ _-]?limit|too\s+many\s+requests|throttl|请求过于频繁|触发限流|限流/i
  },
  {
    category: 'model_not_found',
    pattern:
      /model[^\n]{0,40}(not\s*(exist|found)|does\s+not\s+exist)|not\s*found[^\n]{0,20}model|模型不存在|无可用模型|unknown\s+model|invalid\s+model|decommissioned/i
  },
  {
    category: 'context_too_long',
    pattern:
      /context\s*length|maximum\s*context|prompt\s+is\s+too\s+long|request\s+too\s+large|reduce\s+the\s+length|too\s+long|上下文(长度)?(超|过)(长|限)|内容过长|超出.{0,8}(长度|上下文)/i
  },
  {
    category: 'content_filter',
    pattern:
      /content[ _-]?(filter|policy)|content_policy|moderation|censor|sensitive|敏感|违规|审核未通过|安全策略/i
  },
  {
    category: 'network',
    pattern:
      /网络请求失败|fetch\s*(failed|networkerror)|failed\s+to\s+fetch|network\s*error|\btimeout\b|timed?\s*out|econn(refused|reset|aborted)|enotfound|ehostunreach|enetunreach|socket\s*(hang\s+up|closed)/i
  },
  {
    category: 'server_error',
    pattern:
      /internal\s*(server)?\s*error|server\s*error|overloaded|overloaded_error|bad\s*gateway|service\s*(unavailable|error)|服务器(内部)?错误|服务异常|服务繁忙/i
  }
]

/** 状态码兜底映射（关键词未命中时使用；llm.ts 错误带 status，渲染端兜底路径通常无） */
function categoryFromStatus(status: number | undefined): LlmErrorCategory | null {
  if (status === undefined) return null
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'insufficient_balance'
  if (status === 404) return 'model_not_found'
  if (status === 408) return 'network'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server_error'
  return null
}

/**
 * 把 LLM 错误归类为可操作的友好提示。
 * 关键词优先（服务商经常用 429/500 返回余额不足等业务错误，语义比状态码更准），
 * 状态码兜底，都未命中落 unknown（friendly 为空串，UI 原样展示 raw）。
 * status 缺省时（补拉/渲染端反推路径）从 message 前缀解析：
 * 主进程 LlmError 拼接为 `[<status>] ...`，无 JSON body 时原文为 `HTTP <status>`。
 */
export function classifyLlmError(message: string, status?: number): LlmErrorHint {
  const m = /^\[(\d{3})\]\s|^HTTP\s*(\d{3})\b/.exec(message)
  const st = status ?? (m ? Number(m[1] ?? m[2]) : undefined)
  const category: LlmErrorCategory =
    KEYWORD_RULES.find((r) => r.pattern.test(message))?.category ??
    categoryFromStatus(st) ??
    'unknown'
  return { category, friendly: LLM_ERROR_FRIENDLY[category], raw: message }
}

/** notice/toast 等纯文本场景：有分类提示时用提示文案，否则原样返回 */
export function friendlyLlmMessage(message: string, hint?: LlmErrorHint): string {
  const friendly = hint?.friendly ?? classifyLlmError(message).friendly
  return friendly || message
}
