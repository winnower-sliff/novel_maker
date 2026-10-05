/**
 * 伏笔章节引用 uid 的展示解析：uid 有效 → 「第N章」（随重排自动跟随）；
 * uid 为空 → 回退旧文本（存量/未引用）；悬空（uid 非空但章已删）→ null，调用方标红或提示待重设。
 */
export function buildOutlineNoIndex(
  outlines: Array<{ id: string; chapterNo: number }>
): Map<string, number> {
  return new Map(outlines.map((o) => [o.id, o.chapterNo]))
}

export function formatChapterRef(
  text: string,
  outlineId: string,
  nosById: Map<string, number>
): string | null {
  if (!outlineId) return text
  const no = nosById.get(outlineId)
  return no === undefined ? null : `第${no}章`
}

export function isDanglingRef(outlineId: string, nosById: Map<string, number>): boolean {
  return outlineId !== '' && !nosById.has(outlineId)
}

/** 解析「第N章」/「第V卷N章」（含「第V卷第N章」）为结构化章号；区间、模糊表述返回 null */
export function parseChapterRefText(text: string): { volume?: number; chapter: number } | null {
  const t = text.trim()
  let m = /^第(\d+)卷第?(\d+)章$/.exec(t)
  if (m) return { volume: Number(m[1]), chapter: Number(m[2]) }
  m = /^第(\d+)章$/.exec(t)
  if (m) return { chapter: Number(m[1]) }
  return null
}

/**
 * 章号文本 → 大纲行。裸「第N章」按全局章号唯一命中（chapterNo 全书连续）；
 * 「第V卷N章」按 (volume, chapterNo) 二元组精确匹配——与大纲身份键一致，agent 照
 * list_outlines 输出的 volume+chapterNo 书写时必然命中；人类按卷内局部计数书写时
 * 命中不上则退化为纯文本（宁可不关联，不错链）。返回 null 表示无法唯一解析。
 */
export function resolveChapterRefToOutline<
  T extends { id: string; volume: number; chapterNo: number }
>(text: string, outlines: T[]): T | null {
  const ref = parseChapterRefText(text)
  if (!ref) return null
  if (ref.volume !== undefined)
    return outlines.find((o) => o.volume === ref.volume && o.chapterNo === ref.chapter) ?? null
  const hits = outlines.filter((o) => o.chapterNo === ref.chapter)
  return hits.length === 1 ? hits[0] : null
}
