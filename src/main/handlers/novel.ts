import type { SearchHit } from '../../shared/types'
import { buildChapterContext } from '../context'
import { deleteEmbeddingsByRef, enqueueEmbedding, semanticSearch } from '../embedding'
import { buildProjectGraph } from '../graph'
import { commitWorldbuildChunk, relinkWorldbuildEntries, saveWorldbuildBatch } from '../pipeline'
import * as store from '../store'
import type { PartialHandlerTable } from './context'

export const novelHandlers = {
  'novel:projects': () => store.listProjects(),
  'novel:projectCreate': (_ctx, [input]) => store.createProject(input),
  'novel:projectUpdate': (_ctx, [id, input]) => store.updateProject(id, input),
  'novel:projectDelete': (_ctx, [id]) => store.deleteProject(id),
  'novel:characters': (_ctx, [projectId]) => store.listCharacters(projectId),
  'novel:characterSave': (_ctx, [input]) => {
    const saved = store.saveCharacter(input)
    enqueueEmbedding(
      saved.projectId,
      'character',
      saved.id,
      `${saved.name} ${saved.role} ${saved.tags} ${saved.card}`
    )
    return saved
  },
  'novel:characterDelete': (_ctx, [id]) => {
    deleteEmbeddingsByRef('character', id)
    store.deleteCharacter(id)
  },
  'novel:worldbuild': (_ctx, [projectId]) => store.listWorldbuild(projectId),
  'novel:worldbuildSave': (_ctx, [input]) => {
    const saved = store.saveWorldbuild(input)
    enqueueEmbedding(
      saved.projectId,
      'worldbuild',
      saved.id,
      `${saved.title} ${saved.keys} ${saved.tags} ${saved.content}`
    )
    return saved
  },
  'novel:worldbuildDelete': (_ctx, [id]) => {
    deleteEmbeddingsByRef('worldbuild', id)
    store.deleteWorldbuild(id)
  },
  'novel:worldbuildDeleteBatch': (_ctx, [projectId, ids]) => {
    for (const id of ids) deleteEmbeddingsByRef('worldbuild', id)
    return store.deleteWorldbuildBatch(projectId, ids)
  },
  'novel:worldbuildCommitChunk': (_ctx, [projectId, rawText, categories, opts]) =>
    commitWorldbuildChunk(projectId, rawText, categories, opts),
  'novel:worldbuildRelink': (_ctx, [projectId, entryIds]) =>
    relinkWorldbuildEntries(projectId, entryIds),
  'novel:worldbuildRetrieve': async (_ctx, [p]) => {
    const { runWorldbuildRetrieval } = await import('./stream')
    const retrieval = await runWorldbuildRetrieval(p)
    if (!retrieval || retrieval.entries.length === 0) return null
    return {
      types: retrieval.types,
      tags: retrieval.tags,
      count: retrieval.entries.length,
      titles: retrieval.entries.map((e) => e.title)
    }
  },
  'novel:worldbuildSaveBatch': (_ctx, [projectId, entries]) =>
    saveWorldbuildBatch(projectId, entries),
  'novel:worldbuildTypes': (_ctx, [projectId]) => store.listWorldbuildTypes(projectId),
  'novel:worldbuildTypeCreate': (_ctx, [projectId, name]) => {
    store.createWorldbuildType(projectId, name)
    return store.listWorldbuildTypes(projectId)
  },
  'novel:worldbuildTypeDelete': (_ctx, [projectId, name]) => {
    store.deleteWorldbuildType(projectId, name)
    return store.listWorldbuildTypes(projectId)
  },
  'novel:worldbuildTypeReorder': (_ctx, [projectId, name, pos]) =>
    store.reorderWorldbuildType(projectId, name, pos),
  'novel:outlines': (_ctx, [projectId]) => store.listOutlines(projectId),
  'novel:outlineSave': (_ctx, [input]) => store.saveOutline(input),
  'novel:outlineDelete': (_ctx, [id]) => store.deleteOutline(id),
  'novel:chapterBriefs': (_ctx, [projectId]) => store.listChapterBriefs(projectId),
  'novel:chapter': (_ctx, [outlineId]) => store.getChapterByOutline(outlineId),
  'novel:saveChapter': (_ctx, [input]) => store.saveChapter(input),
  'novel:contextPreview': (_ctx, [outlineId]) => {
    const outline = store.getOutline(outlineId)
    if (!outline) throw new Error('章节不存在')
    return buildChapterContext(outline.projectId, outlineId)
  },
  'novel:foreshadows': (_ctx, [projectId]) => store.listForeshadows(projectId),
  'novel:foreshadowSave': (_ctx, [input]) => store.saveForeshadow(input),
  'novel:foreshadowDelete': (_ctx, [id]) => store.deleteForeshadow(id),
  'novel:summary': (_ctx, [outlineId]) => {
    const chapter = store.getChapterByOutline(outlineId)
    return chapter ? store.getSummary(chapter.id) : null
  },
  'novel:volumeSummary': (_ctx, [projectId, volume]) => store.getVolumeSummary(projectId, volume),
  'novel:volumeSummaries': (_ctx, [projectId]) => store.listVolumeSummaries(projectId)
} satisfies PartialHandlerTable
