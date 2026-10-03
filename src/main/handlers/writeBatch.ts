// 批量自动写作编排（主进程）：手机熄屏/页面切走后电脑端继续逐章写作，
// 进度经 write:batch 事件广播 + write:batchStatus 拉取（断连补拉）。
import type { DonePayload } from '../../shared/contract'
import type { BatchSnapshot } from '../../shared/types'
import { enqueueEmbedding } from '../embedding'
import type { EventSink } from '../eventSink'
import { type LintReport, lintChapterReport, stripHtmlComments } from '../lint'
import {
  applySummaryResult,
  applyVolumeSummaryResult,
  buildAlignRequest,
  buildChapterRequest,
  buildPolishRequest,
  buildSummaryRequest,
  buildVolumeSummaryRequest,
  parseAlignResult
} from '../pipeline'
import * as store from '../store'
import type { PartialHandlerTable } from './context'
import {
  abortLlmRequest,
  LONG_CHAPTER_THRESHOLD,
  type SettleCb,
  startChapterCandidatesStream,
  startLongChapterStream,
  startStream
} from './stream'

interface ChapterDoneData {
  chapterId?: string
  wordCount?: number
  longMode?: boolean
  segments?: number
  candidateMode?: boolean
  lint?: LintReport | null
  error?: string
}

interface InternalBatch extends BatchSnapshot {
  stopFlag: boolean
  currentRid: string | null
  opts: {
    wordTarget?: number
    candidates?: number
    pauseEach: boolean
    /** 全卷重写语义：完成后自动重新生成该卷卷摘要（启动时先清旧摘要） */
    regenVolumeSummary?: boolean
    volume?: number
  }
}

const batches = new Map<string, InternalBatch>()

function snapshotOf(projectId: string): BatchSnapshot | null {
  const b = batches.get(projectId)
  if (!b) return null
  const { projectId: pid, running, paused, done, total, currentNo, log, resumeIds } = b
  return { projectId: pid, running, paused, done, total, currentNo, log: [...log], resumeIds }
}

/** 全部项目批量快照（runtime:snapshot 用） */
export function allBatchesSnapshot(): BatchSnapshot[] {
  return [...batches.keys()].map((pid) => snapshotOf(pid)).filter((s): s is BatchSnapshot => !!s)
}

function publish(sink: EventSink, projectId: string): void {
  const snap = snapshotOf(projectId)
  if (snap && !sink.isClosed()) sink.send('write:batch', projectId, snap)
}

/** 等待单次流式生成完成（主进程内编排用；事件照发，渲染端在场仍能看到流式进度） */
function waitStream(
  sink: EventSink,
  params: Parameters<typeof startStream>[1],
  opts: Parameters<typeof startStream>[2] & { onSettled?: SettleCb }
): { rid: string; done: Promise<DonePayload> } {
  let settle: SettleCb = () => {}
  const done = new Promise<DonePayload>((resolve, reject) => {
    settle = (err, payload) => (err ? reject(new Error(err)) : resolve(payload as DonePayload))
  })
  const rid = startStream(sink, params, { ...opts, onSettled: settle })
  return { rid, done }
}

/** 单章生成（与 pipeline 'chapter' 分流一致：候选/长章/普通） */
function runChapterStep(
  sink: EventSink,
  b: InternalBatch,
  outlineId: string
): Promise<DonePayload> {
  const outline = store.getOutline(outlineId)
  if (!outline) return Promise.reject(new Error('章节不存在'))
  const { wordTarget, candidates } = b.opts
  return new Promise<DonePayload>((resolve, reject) => {
    const settle: SettleCb = (err, payload) => {
      b.currentRid = null
      if (err) reject(new Error(err))
      else resolve(payload as DonePayload)
    }
    if (candidates && candidates >= 2) {
      b.currentRid = startChapterCandidatesStream(
        sink,
        outline.projectId,
        outlineId,
        wordTarget ?? 2700,
        candidates,
        settle
      )
      return
    }
    if (wordTarget && wordTarget >= LONG_CHAPTER_THRESHOLD) {
      b.currentRid = startLongChapterStream(sink, outline.projectId, outlineId, wordTarget, settle)
      return
    }
    buildChapterRequest(outline.projectId, outlineId, wordTarget)
      .then((built) => {
        const { rid, done } = waitStream(sink, built.params, {
          action: 'chapter',
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
        b.currentRid = rid
        done.then(resolve, reject)
      })
      .catch(reject)
  })
}

async function runBatchLoop(sink: EventSink, b: InternalBatch, ids: string[]): Promise<void> {
  const results: boolean[] = []
  let consecutiveFail = 0
  const log = (line: string): void => {
    b.log.push(line)
    if (b.log.length > 500) b.log.splice(0, b.log.length - 500)
    publish(sink, b.projectId)
  }

  for (let i = 0; i < ids.length; i++) {
    if (b.stopFlag) break
    const brief = store.getOutline(ids[i])
    if (!brief) continue
    b.currentNo = brief.chapterNo
    log(`第${brief.chapterNo}章 生成中…`)
    try {
      const gen = await runChapterStep(sink, b, ids[i])
      const d = gen.data as ChapterDoneData
      b.done++
      log(
        `第${brief.chapterNo}章 初稿 ${d?.wordCount ?? 0} 字${d?.longMode ? `（长章 ${d.segments} 段）` : ''}`
      )

      // 硬闸判定 + 自动返修（一次）
      let passed = d?.lint?.pass !== false
      let repaired = false
      if (!passed && d?.lint) {
        const focus = d.lint.issues
          .map((it) => `- ${it.rule}：${it.advice}${it.quote ? `（原文：${it.quote}）` : ''}`)
          .join('\n')
        log(`第${brief.chapterNo}章 硬闸未过（${d.lint.issues.length} 项），自动返修…`)
        repaired = true
        try {
          const outline = store.getOutline(ids[i])
          if (!outline) throw new Error('章节不存在')
          await waitStream(sink, buildPolishRequest(outline.projectId, ids[i], focus), {
            action: 'polish',
            afterDone: (r) => {
              const chapter = store.saveChapter({
                outlineId: ids[i],
                projectId: outline.projectId,
                content: stripHtmlComments(r.text),
                status: 'polished'
              })
              return { wordCount: chapter.wordCount, saved: true }
            }
          }).done
          const re = lintChapterReport(ids[i], store.getChapterByOutline(ids[i])?.content ?? '')
          passed = re.pass
          log(
            passed
              ? `第${brief.chapterNo}章 返修通过`
              : `第${brief.chapterNo}章 返修仍未过 → 需人工`
          )
        } catch (err) {
          log(`第${brief.chapterNo}章 返修失败：${(err as Error).message}`)
        }
      }

      try {
        if (!store.getChapterByOutline(ids[i])) throw new Error('该章节还没有正文')
        await waitStream(sink, buildSummaryRequest(brief.projectId, ids[i]), {
          action: 'summary',
          afterDone: (r) => applySummaryResult(brief.projectId, ids[i], r.text)
        }).done
        log(`第${brief.chapterNo}章 ${passed ? '✓ 完成' : '⚠ 已写入（需人工）'}`)
      } catch (err) {
        log(`第${brief.chapterNo}章 摘要失败：${(err as Error).message}`)
      }
      // 大纲状态自动流转：写完即标，不等手动定稿；章节行状态同步升级（徽章/导出以章节行为准）
      try {
        store.saveOutline({
          id: ids[i],
          projectId: brief.projectId,
          volume: brief.volume,
          chapterNo: brief.chapterNo,
          title: brief.title,
          synopsis: brief.synopsis,
          status: repaired && passed ? 'polished' : 'written'
        })
        store.raiseChapterStatus(ids[i], repaired && passed ? 'polished' : 'written')
      } catch {
        /* 状态流转失败不阻断批量 */
      }
      publish(sink, b.projectId)

      results.push(passed)
      consecutiveFail = passed ? 0 : consecutiveFail + 1
      const window10 = results.slice(-10)
      const failIn10 = window10.filter((r) => !r).length
      if (consecutiveFail >= 3 || (window10.length >= 10 && failIn10 >= 6)) {
        log(
          `⚠ 熔断：连续 ${consecutiveFail} 章未过（近期 ${failIn10}/${window10.length}）——暂停批量，建议先排查根因`
        )
        b.resumeIds = ids.slice(i + 1)
        b.paused = true
        b.running = false
        publish(sink, b.projectId)
        return
      }

      if (b.opts.pauseEach && i < ids.length - 1 && !b.stopFlag) {
        b.resumeIds = ids.slice(i + 1)
        b.paused = true
        b.running = false
        publish(sink, b.projectId)
        return
      }
    } catch (err) {
      b.currentRid = null
      if (b.stopFlag) {
        log(`第${brief.chapterNo}章 已停止`)
      } else {
        log(`第${brief.chapterNo}章 失败：${(err as Error).message}`)
        b.running = false
      }
      publish(sink, b.projectId)
      return
    }
  }

  // 全部跑完（非中止/熔断）→ 附带自动对齐后续大纲
  if (!b.stopFlag && results.length === ids.length) {
    log('自动对齐后续大纲…')
    try {
      const payload = await waitStream(sink, buildAlignRequest(b.projectId), {
        action: 'outlineAlign',
        afterDone: (r) => parseAlignResult(b.projectId, r.text)
      }).done
      const d = payload.data as {
        parsed?: boolean
        revisions?: {
          outlineId: string
          volume: number
          chapterNo: number
          title: string
          synopsis: string
          scenes?: string[]
          hook: string
        }[]
        error?: string
      }
      if (d?.error) throw new Error(d.error)
      if (!d?.parsed || !d.revisions) throw new Error('对齐结果解析失败')
      for (const r of d.revisions) {
        store.saveOutline({
          id: r.outlineId,
          projectId: b.projectId,
          volume: r.volume,
          chapterNo: r.chapterNo,
          title: r.title,
          synopsis: r.synopsis,
          ...(r.scenes && r.scenes.length > 0 ? { scenes: r.scenes } : {}),
          hook: r.hook
        })
      }
      log(
        d.revisions.length > 0
          ? `自动对齐完成：已修订 ${d.revisions.length} 章大纲梗概`
          : '自动对齐：后续大纲与已写剧情一致，无需修订'
      )
    } catch (err) {
      log(`自动对齐失败：${(err as Error).message}`)
    }
  }

  // 全卷重写语义：重新生成该卷卷摘要（旧摘要已在启动时清除）
  if (b.opts.regenVolumeSummary && b.opts.volume && !b.stopFlag && !b.paused) {
    const volume = b.opts.volume
    log(`重新生成第 ${volume} 卷摘要…`)
    try {
      await waitStream(sink, buildVolumeSummaryRequest(b.projectId, volume), {
        action: 'volumeSummary',
        afterDone: (r) => applyVolumeSummaryResult(b.projectId, volume, r.text)
      }).done
      log(`第 ${volume} 卷摘要已更新`)
    } catch (err) {
      log(`卷摘要生成失败：${(err as Error).message}`)
    }
  }
  b.running = false
  publish(sink, b.projectId)
}

export const writeHandlers = {
  'write:batchStart': (ctx, [p]) => {
    if (batches.get(p.projectId)?.running) throw new Error('已有批量任务在运行')
    let ids: string[]
    let opts: InternalBatch['opts']
    if (p.resume) {
      const prev = batches.get(p.projectId)
      if (!prev?.resumeIds?.length) throw new Error('没有可继续的任务')
      ids = prev.resumeIds
      opts = prev.opts
    } else {
      if (!p.ids || p.ids.length === 0) throw new Error('章节范围不能为空')
      ids = p.ids
      const volumes = new Set(
        ids
          .map((id) => store.getOutline(id)?.volume)
          .filter((v): v is number => typeof v === 'number')
      )
      opts = {
        wordTarget: p.wordTarget,
        candidates: p.candidates,
        pauseEach: p.pauseEach ?? false,
        regenVolumeSummary: p.regenVolumeSummary,
        volume: volumes.size === 1 ? [...volumes][0] : undefined
      }
      if (opts.regenVolumeSummary && opts.volume) {
        store.clearVolumeSummary(p.projectId, opts.volume)
      }
    }
    const b: InternalBatch = {
      projectId: p.projectId,
      running: true,
      paused: false,
      done: 0,
      total: ids.length,
      currentNo: 0,
      log: [],
      resumeIds: null,
      stopFlag: false,
      currentRid: null,
      opts
    }
    batches.set(p.projectId, b)
    publish(ctx.sink, p.projectId)
    void runBatchLoop(ctx.sink, b, ids)
    return snapshotOf(p.projectId) as BatchSnapshot
  },

  'write:batchStop': (ctx, [p]) => {
    const b = batches.get(p.projectId)
    if (!b) return null
    b.stopFlag = true
    b.resumeIds = null
    b.running = false
    b.paused = false
    if (b.currentRid) abortLlmRequest(b.currentRid)
    publish(ctx.sink, p.projectId)
    return snapshotOf(p.projectId)
  },

  'write:batchStatus': (_ctx, [p]) => snapshotOf(p.projectId)
} satisfies PartialHandlerTable
