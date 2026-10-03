import type { ChapterBrief } from '@shared/types'
import { type ReactElement, useState } from 'react'
import { type AlignRevision, applyAlignRevisions } from './outlineAlign'
import { startPipeline } from './pipeline'
import { pushToast } from './toastStore'
import type { WizardUi } from './uiTypes'
import { useWriteRunStore } from './writeRunStore'

/** 正文改动落库后，对照已写剧情检查后续大纲；应用修订后可一键自动重写后续已写章（无备份） */
export function ChainBanner({
  ui,
  projectId,
  brief,
  briefs,
  onDone
}: {
  ui: WizardUi
  projectId: string
  brief: ChapterBrief
  briefs: ChapterBrief[]
  onDone: () => void
}): ReactElement {
  const { Button } = ui
  const [alignBusy, setAlignBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [revs, setRevs] = useState<AlignRevision[] | null>(null)
  const [skip, setSkip] = useState<Set<string>>(new Set())
  const [working, setWorking] = useState(false)

  const runAlign = (): void => {
    setAlignBusy(true)
    setMsg('AI 正在对照已写剧情检查后续大纲…')
    void startPipeline('outlineAlign', { projectId })
      .done.then((d) => {
        const r = d.data as { parsed: boolean; revisions: AlignRevision[] }
        if (!r?.parsed) {
          setMsg('AI 输出无法解析，请重试')
          return
        }
        if (r.revisions.length === 0) {
          setMsg('后续大纲与已写剧情一致，无需修订')
          return
        }
        setSkip(new Set())
        setRevs(r.revisions)
        setMsg(null)
      })
      .catch((err: Error) => setMsg(`出错：${err.message}`))
      .finally(() => setAlignBusy(false))
  }

  const apply = async (thenRewrite: boolean): Promise<void> => {
    if (!revs) return
    const list = revs.filter((r) => !skip.has(r.outlineId))
    setWorking(true)
    try {
      if (list.length > 0) await applyAlignRevisions(projectId, list)
      let followIds: string[] = []
      if (thenRewrite) {
        followIds = briefs
          .filter((b) => b.hasDraft && b.chapterNo > brief.chapterNo)
          .sort((a, b) => a.chapterNo - b.chapterNo)
          .map((b) => b.id)
        if (followIds.length === 0) {
          setMsg(
            list.length > 0
              ? `已修订 ${list.length} 章大纲；没有后续已写章节需要重写`
              : '没有后续已写章节需要重写'
          )
          setRevs(null)
          return
        }
        if (
          !window.confirm(
            `将自动重写第 ${brief.chapterNo + 1} 章起共 ${followIds.length} 章正文，现有内容会被覆盖且不可恢复。继续？`
          )
        ) {
          return
        }
        const snap = await window.api.write.batchStart({ projectId, ids: followIds })
        useWriteRunStore.setState({ batch: snap, resumeIds: snap.resumeIds, batchOpen: true })
        pushToast('success', `已开始自动重写 ${followIds.length} 章，进度见写作页`)
        onDone()
        return
      }
      setMsg(list.length > 0 ? `已修订 ${list.length} 章大纲` : '未选择任何修订')
      setRevs(null)
    } catch (err) {
      setMsg(`出错：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="border-b border-amber-900/50 bg-amber-950/30 px-3 py-2">
      <div className="text-xs text-amber-300">正文已修改，后续大纲可能失配</div>
      {msg && <div className="mt-1 text-[11px] leading-4 text-zinc-400">{msg}</div>}
      {revs && (
        <div className="mt-1.5 space-y-1.5">
          {revs.map((r) => {
            const checked = !skip.has(r.outlineId)
            return (
              <button
                key={r.outlineId}
                type="button"
                onClick={() =>
                  setSkip((prev) => {
                    const next = new Set(prev)
                    if (next.has(r.outlineId)) next.delete(r.outlineId)
                    else next.add(r.outlineId)
                    return next
                  })
                }
                className={`block w-full rounded-lg border px-2.5 py-2 text-left ${
                  checked ? 'border-zinc-700 bg-zinc-900' : 'border-zinc-800 bg-zinc-950 opacity-50'
                }`}
              >
                <div className="text-[11px] text-zinc-300">
                  {checked ? '☑' : '☐'} 第{r.chapterNo}章 {r.title}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-zinc-500">
                  {r.synopsis}
                </div>
              </button>
            )
          })}
          <div className="flex gap-2">
            <Button
              variant="danger"
              className="flex-1 px-2 py-1.5 text-[11px]"
              disabled={working || skip.size === revs.length}
              onClick={() => void apply(true)}
            >
              应用所选并重写后续章节
            </Button>
            <Button
              variant="ghost"
              className="px-2 py-1.5 text-[11px]"
              disabled={working}
              onClick={() => void apply(false)}
            >
              仅修订大纲
            </Button>
          </div>
          <div className="text-[10px] leading-4 text-zinc-600">
            重写会覆盖后续已写章节正文且不可恢复；跨卷的所有后续已写章都会重写。
          </div>
        </div>
      )}
      {!revs && !msg && (
        <div className="mt-1.5 flex gap-2">
          <Button
            className="flex-1 px-2 py-1.5 text-[11px]"
            disabled={alignBusy}
            onClick={runAlign}
          >
            {alignBusy ? '检查中…' : '对齐检查'}
          </Button>
          <Button variant="ghost" className="px-2 py-1.5 text-[11px]" onClick={onDone}>
            忽略
          </Button>
        </div>
      )}
    </div>
  )
}
