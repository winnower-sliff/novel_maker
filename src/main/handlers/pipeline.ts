import { PIPELINE_PARAM_SCHEMAS } from '../../shared/contract'
import { enqueueEmbedding } from '../embedding'
import { lintChapterReport, stripHtmlComments } from '../lint'
import {
  applyOutlineResult,
  applyStateSyncResult,
  applySummaryResult,
  applyVolumeSummaryResult,
  buildAlignRequest,
  buildChapterRequest,
  buildCharacterRequest,
  buildCheckRequest,
  buildExpandRequest,
  buildOutlineRequest,
  buildPolishRequest,
  buildPremiseDraftRequest,
  buildReviewRequest,
  buildStateSyncRequest,
  buildSummaryRequest,
  buildVolumeSummaryRequest,
  buildWorldbuildRequest,
  guessCharacterName,
  parseAlignResult,
  parseCharacterCards,
  parseCheckResult,
  parsePremiseDraft,
  parseReviewResult,
  previewWorldbuildResult
} from '../pipeline'
import * as store from '../store'
import type { PartialHandlerTable } from './context'
import {
  LONG_CHAPTER_THRESHOLD,
  runWorldbuildRetrieval,
  startChapterCandidatesStream,
  startLongChapterStream,
  startStream
} from './stream'

type ParsedCharacterCards = ReturnType<typeof parseCharacterCards>

/** 解析结果落库：主卡新建/更新 + 修订卡按名匹配已有人物（character 管线 save=true 路径） */
function saveParsedCharacters(
  projectId: string,
  parsed: ParsedCharacterCards,
  fallbackName: string
): { characterId?: string; name: string; revised: Array<{ id: string; name: string }> } {
  let characterId: string | undefined
  let name = ''
  if (parsed.main) {
    name = guessCharacterName(parsed.main, fallbackName)
    const character = store.saveCharacter({
      projectId,
      name,
      tags: parsed.mainTags.join(','),
      card: parsed.main
    })
    characterId = character.id
  }
  const revised: Array<{ id: string; name: string }> = []
  if (parsed.revisions.length > 0) {
    const existing = store.listCharacters(projectId)
    for (const rev of parsed.revisions) {
      const hit = existing.find((c) => c.name.trim() === rev.name)
      if (!hit || !rev.card.trim()) continue
      store.saveCharacter({
        id: hit.id,
        projectId,
        name: hit.name,
        role: hit.role,
        tags: rev.tags.length > 0 ? rev.tags.join(',') : hit.tags,
        card: rev.card
      })
      revised.push({ id: hit.id, name: hit.name })
    }
  }
  return { characterId, name, revised }
}

export const pipelineHandlers = {
  'pipeline:run': async (ctx, [action, rawParams]) => {
    switch (action) {
      case 'premiseDraft': {
        const params = PIPELINE_PARAM_SCHEMAS.premiseDraft.parse(rawParams)
        return startStream(ctx.sink, buildPremiseDraftRequest(params.projectId), {
          action,
          meta: { projectId: params.projectId },
          afterDone: (r) => parsePremiseDraft(r.text)
        })
      }
      case 'outline': {
        const params = PIPELINE_PARAM_SCHEMAS.outline.parse(rawParams)
        return startStream(ctx.sink, buildOutlineRequest(params), {
          action,
          meta: { projectId: params.projectId },
          afterDone: (r) => applyOutlineResult(params, r.text),
          // 大章数输出超长被截断时自动续写拼接（与 worldbuild 同机制）
          continueOnMaxTokens: 3
        })
      }
      case 'outlineAlign': {
        const params = PIPELINE_PARAM_SCHEMAS.outlineAlign.parse(rawParams)
        return startStream(ctx.sink, buildAlignRequest(params.projectId), {
          action,
          meta: { projectId: params.projectId },
          afterDone: (r) => parseAlignResult(params.projectId, r.text)
        })
      }
      case 'chapter': {
        const params = PIPELINE_PARAM_SCHEMAS.chapter.parse(rawParams)
        const { outlineId, wordTarget, candidates } = params
        const outline = store.getOutline(outlineId)
        if (!outline) throw new Error('章节不存在')
        if (candidates && candidates >= 2) {
          return startChapterCandidatesStream(
            ctx.sink,
            outline.projectId,
            outlineId,
            wordTarget ?? 2700,
            candidates
          )
        }
        if (wordTarget && wordTarget >= LONG_CHAPTER_THRESHOLD) {
          return startLongChapterStream(ctx.sink, outline.projectId, outlineId, wordTarget)
        }
        const built = await buildChapterRequest(outline.projectId, outlineId, wordTarget)
        return startStream(ctx.sink, built.params, {
          action,
          meta: { projectId: outline.projectId, outlineId },
          afterDone: (r) => {
            const clean = stripHtmlComments(r.text)
            const chapter = store.saveChapter({
              outlineId,
              projectId: outline.projectId,
              content: clean,
              status: 'draft'
            })
            enqueueEmbedding(outline.projectId, 'summary', outlineId, clean.slice(0, 1200))
            return {
              chapterId: chapter.id,
              wordCount: chapter.wordCount,
              contextParts: built.ctx.parts,
              contextTokens: built.ctx.totalTokens,
              lint: lintChapterReport(outlineId, clean)
            }
          }
        })
      }
      case 'summary': {
        const params = PIPELINE_PARAM_SCHEMAS.summary.parse(rawParams)
        const { outlineId, finalize } = params
        const outline = store.getOutline(outlineId)
        if (!outline) throw new Error('章节不存在')
        if (!store.getChapterByOutline(outlineId)) throw new Error('该章节还没有正文')
        if (finalize) {
          store.saveOutline({
            id: outlineId,
            projectId: outline.projectId,
            volume: outline.volume,
            chapterNo: outline.chapterNo,
            title: outline.title,
            synopsis: outline.synopsis,
            status: 'written'
          })
        }
        return startStream(ctx.sink, buildSummaryRequest(outline.projectId, outlineId), {
          action,
          meta: { projectId: outline.projectId, outlineId },
          afterDone: (r) => applySummaryResult(outline.projectId, outlineId, r.text)
        })
      }
      case 'polish': {
        const params = PIPELINE_PARAM_SCHEMAS.polish.parse(rawParams)
        const { outlineId, focus, save } = params
        const outline = store.getOutline(outlineId)
        if (!outline) throw new Error('章节不存在')
        return startStream(ctx.sink, buildPolishRequest(outline.projectId, outlineId, focus), {
          action,
          meta: { projectId: outline.projectId, outlineId },
          afterDone: (r) => {
            if (save) {
              const chapter = store.saveChapter({
                outlineId,
                projectId: outline.projectId,
                content: stripHtmlComments(r.text),
                status: 'polished'
              })
              return { wordCount: chapter.wordCount, saved: true }
            }
            return { wordCount: r.text.replace(/\s/g, '').length }
          }
        })
      }
      case 'check': {
        const params = PIPELINE_PARAM_SCHEMAS.check.parse(rawParams)
        const { outlineId } = params
        const outline = store.getOutline(outlineId)
        if (!outline) throw new Error('章节不存在')
        return startStream(ctx.sink, await buildCheckRequest(outline.projectId, outlineId), {
          action,
          meta: { projectId: outline.projectId, outlineId },
          afterDone: (r) => parseCheckResult(r.text)
        })
      }
      case 'review': {
        const params = PIPELINE_PARAM_SCHEMAS.review.parse(rawParams)
        const { outlineId } = params
        const outline = store.getOutline(outlineId)
        if (!outline) throw new Error('章节不存在')
        return startStream(ctx.sink, await buildReviewRequest(outline.projectId, outlineId), {
          action,
          meta: { projectId: outline.projectId, outlineId },
          afterDone: (r) => parseReviewResult(r.text).result
        })
      }
      case 'expand': {
        const params = PIPELINE_PARAM_SCHEMAS.expand.parse(rawParams)
        const { outlineId, targetWords } = params
        const outline = store.getOutline(outlineId)
        if (!outline) throw new Error('章节不存在')
        if (!targetWords || targetWords < 500) throw new Error('目标字数无效')
        return startStream(
          ctx.sink,
          buildExpandRequest(outline.projectId, outlineId, targetWords),
          {
            action,
            meta: { projectId: outline.projectId, outlineId },
            afterDone: (r) => ({ wordCount: r.text.replace(/\s/g, '').length }),
            continueOnMaxTokens: 2
          }
        )
      }
      case 'volumeSummary': {
        const params = PIPELINE_PARAM_SCHEMAS.volumeSummary.parse(rawParams)
        const { projectId, volume } = params
        return startStream(ctx.sink, buildVolumeSummaryRequest(projectId, volume), {
          action,
          meta: { projectId },
          afterDone: (r) => applyVolumeSummaryResult(projectId, volume, r.text)
        })
      }
      case 'stateSync': {
        const params = PIPELINE_PARAM_SCHEMAS.stateSync.parse(rawParams)
        const { outlineId } = params
        const outline = store.getOutline(outlineId)
        if (!outline) throw new Error('章节不存在')
        return startStream(ctx.sink, buildStateSyncRequest(outline.projectId, outlineId), {
          action,
          meta: { projectId: outline.projectId, outlineId },
          afterDone: (r) => applyStateSyncResult(outline.projectId, r.text)
        })
      }
      case 'character': {
        const params = PIPELINE_PARAM_SCHEMAS.character.parse(rawParams)
        return startStream(
          ctx.sink,
          buildCharacterRequest(params.projectId, params.brief, params.allowUpdate === true),
          {
            action,
            meta: { projectId: params.projectId },
            afterDone: (r) => {
              const parsed = parseCharacterCards(r.text)
              // save=false：班底挑选模式，只回预览不落库（确认后由调用方显式保存）
              if (params.save === false)
                return {
                  preview: { main: parsed.main, mainTags: parsed.mainTags, revisions: parsed.revisions }
                }
              return saveParsedCharacters(params.projectId, parsed, params.name ?? '')
            }
          }
        )
      }
      case 'worldbuild': {
        const params = PIPELINE_PARAM_SCHEMAS.worldbuild.parse(rawParams)
        const retrieval = await runWorldbuildRetrieval(params)
        return startStream(ctx.sink, buildWorldbuildRequest(params, retrieval), {
          action,
          meta: { projectId: params.projectId },
          afterDone: (r) => ({ entries: previewWorldbuildResult(params, r.text) }),
          continueOnMaxTokens: 3
        })
      }
      default:
        throw new Error(`未知的流水线动作: ${String(action)}`)
    }
  }
} satisfies PartialHandlerTable
