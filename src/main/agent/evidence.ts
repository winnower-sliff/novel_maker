/**
 * 沉淀证据校验（M5）：写章任务里 save_card / save_foreshadow 必须附「本章原句」，
 * 这里做纯字符串核对——去空白后原句得是本章正文的连续子串。不调模型、不读设定含义：
 * 目的只是挡住「正文里没写的设定」被当成事实存进长期记忆。
 */

/** 不足这个长度的原句证明不了什么（「的」「沈」这种片语在哪一章都能命中） */
const MIN_LENGTH = 6

/** 引号变体归一：模型抄原句时常把「」换成“”，这不算篡改 */
const QUOTE_ALIASES: Record<string, string> = {
  '“': '"',
  '”': '"',
  '「': '"',
  '」': '"',
  '『': '"',
  '』': '"',
  '‘': "'",
  '’': "'"
}

function squash(text: string): string {
  let out = ''
  for (const ch of text) out += QUOTE_ALIASES[ch] ?? ch
  return out.replace(/\s/g, '')
}

/** 模型常用「……原句……」标记截取：首尾省略号不是正文的一部分 */
function trimEllipsis(text: string): string {
  return text.replace(/^[….]+|[….]+$/g, '')
}

export type EvidenceVerdict = 'ok' | 'too_short' | 'not_found'

export function evidenceInText(evidence: string, content: string): EvidenceVerdict {
  const quote = squash(trimEllipsis(evidence.trim()))
  if (quote.length < MIN_LENGTH) return 'too_short'
  return squash(content).includes(quote) ? 'ok' : 'not_found'
}
