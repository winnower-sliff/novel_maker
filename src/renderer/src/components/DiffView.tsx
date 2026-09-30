import { diffChars } from 'diff'
import { useMemo, useState } from 'react'
import { Button } from './ui'

interface EditBlock {
  removed: string
  added: string
}

type Piece = { kind: 'same'; text: string } | { kind: 'edit'; index: number }

function parseDiff(oldText: string, newText: string): { pieces: Piece[]; blocks: EditBlock[] } {
  const parts = diffChars(oldText, newText)
  const pieces: Piece[] = []
  const blocks: EditBlock[] = []
  let pending: EditBlock | null = null
  const flushBlock = (): void => {
    if (pending) {
      blocks.push(pending)
      pieces.push({ kind: 'edit', index: blocks.length - 1 })
      pending = null
    }
  }
  for (const p of parts) {
    if (p.added) {
      pending = pending ?? { removed: '', added: '' }
      pending.added += p.value
    } else if (p.removed) {
      pending = pending ?? { removed: '', added: '' }
      pending.removed += p.value
    } else {
      flushBlock()
      pieces.push({ kind: 'same', text: p.value })
    }
  }
  flushBlock()
  return { pieces, blocks }
}

export function DiffView({
  oldText,
  newText,
  title,
  onApply,
  onDiscard
}: {
  oldText: string
  newText: string
  title: string
  onApply: (text: string) => void
  onDiscard: () => void
}) {
  const { pieces, blocks } = useMemo(() => parseDiff(oldText, newText), [oldText, newText])
  const [accepted, setAccepted] = useState<boolean[]>(() => blocks.map(() => true))

  const acceptedCount = accepted.filter(Boolean).length

  const apply = (): void => {
    let out = ''
    for (const p of pieces) {
      if (p.kind === 'same') out += p.text
      else if (accepted[p.index]) out += blocks[p.index].added
      else out += blocks[p.index].removed
    }
    onApply(out)
  }

  if (blocks.length === 0) {
    return (
      <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-500">
        {title}：没有检测到差异
        <Button variant="ghost" className="ml-2 px-2 py-0.5 text-xs" onClick={onDiscard}>
          关闭
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        <span className="font-medium text-zinc-200">{title}</span>
        <span>
          共 {blocks.length} 处修改，已采纳 {acceptedCount} 处
        </span>
        <div className="ml-auto flex gap-1.5">
          <Button
            variant="ghost"
            className="px-2 py-0.5 text-xs"
            onClick={() => setAccepted(blocks.map(() => true))}
          >
            全部采纳
          </Button>
          <Button
            variant="ghost"
            className="px-2 py-0.5 text-xs"
            onClick={() => setAccepted(blocks.map(() => false))}
          >
            全部拒绝
          </Button>
          <Button variant="danger" className="px-2 py-0.5 text-xs" onClick={onDiscard}>
            放弃
          </Button>
          <Button className="px-2 py-0.5 text-xs" onClick={apply}>
            应用修订
          </Button>
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto whitespace-pre-wrap text-xs leading-6 text-zinc-400">
        {pieces.map((p, i) =>
          p.kind === 'same' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: 追加式/一次性渲染列表，index 即身份，无重排语义
            <span key={i}>{p.text}</span>
          ) : (
            <button
              type="button"
              // biome-ignore lint/suspicious/noArrayIndexKey: 追加式/一次性渲染列表，index 即身份，无重排语义
              key={i}
              className={`mx-0.5 inline-block cursor-pointer rounded border px-1 align-baseline ${
                accepted[p.index]
                  ? 'border-emerald-700/60 bg-emerald-900/30'
                  : 'border-zinc-700 bg-zinc-800/60 opacity-60'
              }`}
              title={accepted[p.index] ? '点击拒绝此修改' : '点击采纳此修改'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  setAccepted((prev) => prev.map((v, j) => (j === p.index ? !v : v)))
                }
              }}
              onClick={() => setAccepted((prev) => prev.map((v, j) => (j === p.index ? !v : v)))}
            >
              {blocks[p.index].removed && (
                <span className="text-red-400/80 line-through">{blocks[p.index].removed}</span>
              )}
              {blocks[p.index].added && (
                <span
                  className={accepted[p.index] ? 'text-emerald-300' : 'text-zinc-500 line-through'}
                >
                  {blocks[p.index].added}
                </span>
              )}
            </button>
          )
        )}
      </div>
    </div>
  )
}
