import type { ChapterBrief } from './types'

export interface ChapterSegment {
  segNo: number
  from: number
  to: number
  writtenCount: number
  chapters: ChapterBrief[]
}

export interface VolumeSegments {
  volume: number
  segments: ChapterSegment[]
}

export const SEGMENT_SIZE = 20

/**
 * 章节列表按卷分组、每 SEGMENT_SIZE 章折叠为一段。
 * 卷按 briefs 中的首现序排列（不排序），段内按 chapterNo 升序。
 */
export function groupChapterSegments(briefs: ChapterBrief[]): VolumeSegments[] {
  const byVolume = new Map<number, ChapterBrief[]>()
  for (const b of briefs) {
    const list = byVolume.get(b.volume) ?? []
    list.push(b)
    byVolume.set(b.volume, list)
  }

  const result: VolumeSegments[] = []
  for (const [volume, chapters] of byVolume) {
    chapters.sort((a, b) => a.chapterNo - b.chapterNo)
    const segments: ChapterSegment[] = []
    const segMap = new Map<number, ChapterSegment>()
    for (const b of chapters) {
      const segNo = Math.floor((b.chapterNo - 1) / SEGMENT_SIZE)
      let seg = segMap.get(segNo)
      if (!seg) {
        seg = { segNo, from: b.chapterNo, to: b.chapterNo, writtenCount: 0, chapters: [] }
        segMap.set(segNo, seg)
        segments.push(seg)
      }
      seg.chapters.push(b)
      seg.to = b.chapterNo
      if (b.hasDraft) seg.writtenCount += 1
    }
    result.push({ volume, segments })
  }
  return result
}
