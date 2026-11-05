import type { SampleSearchHit } from '../../shared/types.js'
import { listImportFiles, readImportFile } from '../samples.js'
import {
  deleteSample,
  getSample,
  listSampleSections,
  listSamples,
  saveSample,
  updateBook
} from '../store.js'
import type { HandlerTable } from './types.js'

const sampleHandlers: Pick<
  HandlerTable,
  | 'sample:listDir'
  | 'sample:import'
  | 'sample:list'
  | 'sample:attach'
  | 'sample:delete'
  | 'sample:sections'
  | 'sample:readText'
  | 'sample:search'
> = {
  'sample:listDir': () => listImportFiles(),
  'sample:import': async (_ctx, [{ fileName, name }]) => {
    const text = await readImportFile(fileName)
    return saveSample(name || fileName.replace(/\.txt$/i, ''), text)
  },
  'sample:list': () => listSamples(),
  /** 整组设置绑定（多本；空数组=全解绑）。sampleId 不存在时拒绝，防悬空 */
  'sample:attach': (_ctx, [bookId, sampleIds]) => {
    for (const id of sampleIds) {
      if (!getSample(id)) throw new Error(`范文不存在：${id}`)
    }
    const book = updateBook(bookId, { sampleSources: sampleIds })
    if (!book) throw new Error('书不存在')
    return book
  },
  'sample:delete': (_ctx, [sampleId]) => deleteSample(sampleId),
  'sample:sections': (_ctx, [sampleId]) => {
    if (!getSample(sampleId)) throw new Error('范文不存在')
    return listSampleSections(sampleId)
  },
  'sample:readText': (_ctx, [sampleId, from, size]) => {
    const s = getSample(sampleId)
    if (!s) throw new Error('范文不存在')
    const start = Math.max(0, Math.min(from, s.chars))
    const len = Math.max(200, Math.min(size, 10000))
    const text = s.content.slice(start, start + len)
    return { from: start, chars: text.length, text }
  },
  'sample:search': (_ctx, [sampleId, q]) => {
    const s = getSample(sampleId)
    if (!s) throw new Error('范文不存在')
    const query = q.trim()
    if (!query) return []
    const sections = listSampleSections(sampleId)
    const hits: SampleSearchHit[] = []
    // 章标题命中优先
    const byLabel = sections.find((x) => x.label.includes(query))
    if (byLabel) {
      hits.push({
        label: byLabel.label,
        index: byLabel.start,
        snippet: `章标题命中 · ${s.content.slice(byLabel.start, byLabel.start + 80)}…`
      })
    }
    // 正文位置命中，最多 20 条
    let idx = s.content.indexOf(query)
    while (idx >= 0 && hits.length < 20) {
      const sec = [...sections].reverse().find((x) => x.start <= idx && idx < x.end)
      hits.push({
        label: sec?.label ?? '（正文前部）',
        index: idx,
        snippet: `…${s.content.slice(Math.max(0, idx - 40), idx + query.length + 100)}…`
      })
      idx = s.content.indexOf(query, idx + query.length)
    }
    if (hits.length === 0) {
      // 宽松兜底：忽略大小写再找一轮
      const lower = s.content.toLowerCase()
      const lq = query.toLowerCase()
      let i2 = lower.indexOf(lq)
      while (i2 >= 0 && hits.length < 8) {
        hits.push({
          label: '（近义命中）',
          index: i2,
          snippet: `…${s.content.slice(Math.max(0, i2 - 40), i2 + query.length + 100)}…`
        })
        i2 = lower.indexOf(lq, i2 + lq.length)
      }
    }
    return hits
  }
}

export { sampleHandlers }
