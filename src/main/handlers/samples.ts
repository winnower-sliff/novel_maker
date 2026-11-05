import { listImportFiles, readImportFile } from '../samples.js'
import { deleteSample, getSample, listSamples, saveSample, updateBook } from '../store.js'
import type { HandlerTable } from './types.js'

const sampleHandlers: Pick<
  HandlerTable,
  'sample:listDir' | 'sample:import' | 'sample:list' | 'sample:attach' | 'sample:delete'
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
  'sample:delete': (_ctx, [sampleId]) => deleteSample(sampleId)
}

export { sampleHandlers }
