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
