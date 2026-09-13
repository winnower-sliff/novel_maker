import { useEffect, useRef, useState } from 'react'
import { OverlayCard } from './OverlayCard'
import { Button, Input } from './ui'
import { startGen } from '../lib/wbGenStore'

interface WbGenOverlayProps {
  open: boolean
  onClose: () => void
  projectId: string
  types: string[]
  initialTypes: string[]
  initialTags: string[]
  tagOptions: Array<{ name: string; count: number }>
}

export function WbGenOverlay({
  open,
  onClose,
  projectId,
  types,
  initialTypes,
  initialTags,
  tagOptions
}: WbGenOverlayProps) {
  const [brief, setBrief] = useState('')
  const [countInput, setCountInput] = useState('')
  const [limitTypes, setLimitTypes] = useState<string[]>([])
  const [focusTags, setFocusTags] = useState<string[]>([])
  const [retrieval, setRetrieval] = useState<{
    status: 'loading' | 'none' | 'done'
    count?: number
    titles?: string[]
  } | null>(null)
  const retrieveSeq = useRef(0)

  useEffect(() => {
    if (!open) return
    setLimitTypes(initialTypes)
    setFocusTags(initialTags)
    setRetrieval(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const briefForRetrieve =
    brief.trim() ||
    [...focusTags.map((t) => `#${t}`), ...limitTypes].join(' ') ||
    ''
  useEffect(() => {
    if (!briefForRetrieve) {
      setRetrieval(null)
      return
    }
    if (!open) return
    const seq = ++retrieveSeq.current
    setRetrieval({ status: 'loading' })
    const timer = setTimeout(() => {
      void window.api.novel
        .worldbuildRetrieve({
          projectId,
          categories: limitTypes,
          title: '',
          brief: briefForRetrieve,
          tags: focusTags
        })
        .then((r) => {
          if (seq !== retrieveSeq.current) return
          setRetrieval(
            r ? { status: 'done', count: r.count, titles: r.titles } : { status: 'none' }
          )
        })
        .catch(() => {
          if (seq === retrieveSeq.current) setRetrieval({ status: 'none' })
        })
    }, 900)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, briefForRetrieve, projectId])

  const submit = (): void => {
    const text = brief.trim()
    if (!text) return
    const count = Number(countInput)
    startGen({
      projectId,
      categories: limitTypes,
      title: '',
      brief: text,
      count: Number.isFinite(count) && count >= 1 ? Math.floor(count) : undefined,
      tags: focusTags.length > 0 ? focusTags : undefined
    })
    onClose()
  }

  if (!open) return null

  return (
    <OverlayCard
      open={open}
      onClose={onClose}
      title="AI 生成世界观条目"
      widthClass="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={!brief.trim()}>
            生成
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            placeholder="描述想生成的设定，例：精灵一族的起源、社会结构与禁忌，需与已有王国设定咬合"
            className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-700"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="shrink-0 text-zinc-500">类型</span>
          <button
            onClick={() => setLimitTypes([])}
            className={`cursor-pointer rounded-full px-2.5 py-0.5 transition-colors ${
              limitTypes.length === 0
                ? 'bg-amber-600 font-medium text-zinc-950'
                : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            不限（AI 定）
          </button>
          {types.map((t) => (
            <button
              key={t}
              onClick={() =>
                setLimitTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))
              }
              className={`cursor-pointer rounded-full px-2.5 py-0.5 transition-colors ${
                limitTypes.includes(t)
                  ? 'bg-amber-600 font-medium text-zinc-950'
                  : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        {tagOptions.length > 0 && (
          <div className="flex items-start gap-1.5 text-xs">
            <span className="mt-1 shrink-0 text-zinc-500">主题标签</span>
            <div className="flex max-h-20 flex-1 flex-wrap gap-1.5 overflow-y-auto">
              {tagOptions.map((t) => (
                <button
                  key={t.name}
                  onClick={() =>
                    setFocusTags((cur) =>
                      cur.includes(t.name) ? cur.filter((x) => x !== t.name) : [...cur, t.name]
                    )
                  }
                  className={`cursor-pointer rounded-full border px-2.5 py-0.5 transition-colors ${
                    focusTags.includes(t.name)
                      ? 'border-amber-600 bg-amber-600/30 font-medium text-amber-200'
                      : 'border-zinc-700 text-zinc-400 hover:border-amber-700 hover:text-amber-300'
                  }`}
                  title={focusTags.includes(t.name) ? '移除主题标签' : '添加主题标签'}
                >
                  # {t.name}
                  <span className="ml-1 text-[10px] text-zinc-600">{t.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 text-xs">
          <span className="shrink-0 text-zinc-500">条目数上限</span>
          <Input
            type="number"
            min={1}
            value={countInput}
            onChange={(e) => setCountInput(e.target.value)}
            placeholder="默认宏大 50+"
            className="w-28"
          />
          <span className="text-zinc-600">留空则默认宏大构建（50+ 条，每条简短）</span>
        </div>
        {retrieval?.status === 'done' ? (
          <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-500">
            生成时将参考 {retrieval.count} 条相关条目
            {retrieval.titles && retrieval.titles.length > 0 && `：${retrieval.titles.slice(0, 5).join('、')}`}
            {retrieval.titles && retrieval.titles.length > 5 ? ' 等' : ''}
          </div>
        ) : retrieval?.status === 'loading' ? (
          <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-600 animate-pulse">
            正在检索相关已有条目…
          </div>
        ) : retrieval?.status === 'none' ? (
          <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-600">
            未找到强相关的已有条目，将按需求独立生成
          </div>
        ) : (
          <div className="text-xs text-zinc-600">
            生成前会自动检索相关已有条目作为自洽性参考；AI 自动打标签并优先复用已有标签与类型
          </div>
        )}
        <div className="text-xs text-zinc-600">
          生成过程与结果会直接出现在条目列表顶部（生成中黄点、新入库绿点），无需等待确认
        </div>
      </div>
    </OverlayCard>
  )
}
