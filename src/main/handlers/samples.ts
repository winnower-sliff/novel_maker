import { listImportFiles, readImportFile } from '../samples.js'
import { deleteSample, listSamples, saveSample, updateBook } from '../store.js'
import type { HandlerTable } from './types.js'

const sampleHandlers: Pick<
  HandlerTable,
  | 'sample:listDir'
  | 'sample:import'
  | 'sample:list'
  | 'sample:attach'
  | 'sample:detach'
  | 'sample:delete'
> = {
  'sample:listDir': () => listImportFiles(),
  'sample:import': async (_ctx, [{ fileName, name }]) => {
    const text = await readImportFile(fileName)
    return saveSample(name || fileName.replace(/\.txt$/i, ''), text)
  },
  'sample:list': () => listSamples(),
  'sample:attach': (_ctx, [bookId, sampleId]) => {
    const book = updateBook(bookId, { styleSampleSource: sampleId })
    if (!book) throw new Error('书不存在')
    return book
  },
  'sample:detach': (_ctx, [bookId]) => {
    const book = updateBook(bookId, { styleSampleSource: '' })
    if (!book) throw new Error('书不存在')
    return book
  },
  'sample:delete': (_ctx, [sampleId]) => deleteSample(sampleId)
}

export { sampleHandlers }
