import type { AlignRevision } from '@shared/types'

export type { AlignRevision }

/** 把对齐修订落库（按勾选跳过）；返回应用条数。桌面大纲页与手机编辑器连锁共用。 */
export async function applyAlignRevisions(
  projectId: string,
  revisions: AlignRevision[],
  skip?: Set<string>
): Promise<number> {
  let applied = 0
  for (const r of revisions) {
    if (skip?.has(r.outlineId)) continue
    await window.api.novel.outlineSave({
      id: r.outlineId,
      projectId,
      volume: r.volume,
      chapterNo: r.chapterNo,
      title: r.title,
      synopsis: r.synopsis,
      hook: r.hook
    })
    applied += 1
  }
  return applied
}
