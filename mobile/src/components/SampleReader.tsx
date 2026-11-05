import { useEffect, useState } from 'react'
import type { SampleSearchHit, SampleSectionView } from '@shared/types'

/** 阅读窗口大小（8k 字一屏，前后翻页步长） */
const WINDOW = 8000

interface SampleLite {
  id: string
  name: string
  chars: number
}

interface TextView {
  label: string
  from: number
  len: number
  text: string
  secIdx: number
}

/** 范文阅读层：目录 / 正文翻页 / 关键词检索（全屏覆盖层） */
export function SampleReader({ sample, onClose }: { sample: SampleLite; onClose: () => void }) {
  const [sections, setSections] = useState<SampleSectionView[] | null>(null)
  const [err, setErr] = useState('')
  const [view, setView] = useState<TextView | null>(null)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SampleSearchHit[] | null>(null)

  useEffect(() => {
    let dead = false
    window.api.sample
      .sections(sample.id)
      .then((r) => {
        if (!dead) setSections(r)
      })
      .catch((e) => {
        if (!dead) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      dead = true
    }
  }, [sample.id])

  const openText = async (label: string, from: number, secIdx: number, len = WINDOW) => {
    setBusy(true)
    setErr('')
    try {
      const t = await window.api.sample.readText(sample.id, from, len)
      setView({ label, from: t.from, len: t.chars, text: t.text, secIdx })
      setHits(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openSection = (i: number) => {
    const s = sections?.[i]
    if (!s) return
    void openText(s.label, s.start, i, Math.min(WINDOW, Math.max(WINDOW, s.chars)))
  }

  const jumpSection = (delta: number) => {
    if (!view) return
    openSection(view.secIdx + delta)
  }

  const page = (delta: number) => {
    if (!view) return
    const from = Math.max(0, Math.min(view.from + delta, sample.chars - 500))
    void openText(view.label, from, view.secIdx)
  }

  const doSearch = async () => {
    if (!q.trim()) return
    setBusy(true)
    setErr('')
    try {
      const r = await window.api.sample.search(sample.id, q)
      setHits(r)
      if (r.length === 0) setErr(`没找到「${q}」`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openHit = (h: SampleSearchHit) => {
    if (!sections) return
    const i = sections.findIndex((s) => s.start <= h.index && h.index < s.end)
    // 命中位置前移 600 字起读，保证关键词上下文可见
    void openText(h.label, Math.max(0, h.index - 600), Math.max(0, i))
  }

  const pctJump = (pct: number) => {
    void openText(`全文 ${pct}%`, Math.floor((sample.chars * pct) / 100), -1)
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-[#fbf6ec]">
      {/* 头部 */}
      <header className="flex items-center justify-between border-b border-orange-100 bg-white px-4 pb-2 pt-safe">
        <button type="button" className="pt-2 text-sm text-stone-500" onClick={onClose}>
          关闭
        </button>
        <div className="min-w-0 pt-2 text-center">
          <div className="truncate text-sm font-medium text-orange-500">{sample.name}</div>
          <div className="text-[10px] text-stone-400">
            {sample.chars.toLocaleString()} 字
            {sections ? ` · ${sections.filter((s) => s.kind === 'chapter').length} 章` : ''}
          </div>
        </div>
        <div className="w-10" />
      </header>

      {err && (
        <button
          type="button"
          className="mx-4 mt-2 rounded-lg bg-amber-100 px-3 py-2 text-left text-xs text-orange-800"
          onClick={() => setErr('')}
        >
          {err} · 点按关闭
        </button>
      )}

      {/* 正文阅读态 */}
      {view ? (
        <>
          <div className="border-b border-orange-100 bg-white/70 px-4 py-2">
            <div className="flex items-center justify-between text-[11px] text-stone-400">
              <span className="min-w-0 flex-1 truncate">{view.label}</span>
              <span className="ml-2 shrink-0">
                {Math.round(((view.from + view.len) / sample.chars) * 100)}%
              </span>
            </div>
          </div>
          <div className="no-scrollbar flex-1 overflow-y-auto px-5 py-4">
            {view.text.split('\n').map((para, i) =>
              para.trim() ? (
                <p key={i} className="mb-3 indent-[2em] text-[15.5px] leading-[1.9] text-stone-800">
                  {para}
                </p>
              ) : null
            )}
          </div>
          <div className="border-t border-orange-100 bg-white pb-safe pt-2">
            <div className="grid grid-cols-3 gap-2 px-4">
              <button
                type="button"
                disabled={busy || view.secIdx <= 0}
                className="rounded-xl border border-orange-200 py-2 text-xs text-stone-600 disabled:opacity-40"
                onClick={() => jumpSection(-1)}
              >
                ◀ 上一节
              </button>
              <button
                type="button"
                className="rounded-xl border border-orange-200 py-2 text-xs text-orange-700"
                onClick={() => setView(null)}
              >
                目录
              </button>
              <button
                type="button"
                disabled={busy || !sections || view.secIdx >= sections.length - 1}
                className="rounded-xl border border-orange-200 py-2 text-xs text-stone-600 disabled:opacity-40"
                onClick={() => jumpSection(1)}
              >
                下一节 ▶
              </button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 px-4 pb-2">
              <button
                type="button"
                disabled={busy || view.from <= 0}
                className="rounded-xl bg-orange-50 py-2 text-xs text-stone-600 disabled:opacity-40"
                onClick={() => page(-WINDOW)}
              >
                向前翻
              </button>
              <button
                type="button"
                disabled={busy || view.from + view.len >= sample.chars}
                className="rounded-xl bg-orange-50 py-2 text-xs text-stone-600 disabled:opacity-40"
                onClick={() => page(WINDOW)}
              >
                向后翻
              </button>
            </div>
          </div>
        </>
      ) : (
        /* 目录态 */
        <>
          <div className="flex gap-2 px-4 py-3">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doSearch()
              }}
              placeholder="在全文里搜：人名 / 桥段 / 词句…"
              className="min-w-0 flex-1 rounded-xl border border-orange-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
            />
            <button
              type="button"
              disabled={busy}
              className="shrink-0 rounded-xl bg-orange-600 px-4 text-sm text-white disabled:opacity-50"
              onClick={() => void doSearch()}
            >
              搜
            </button>
          </div>
          <div className="no-scrollbar flex-1 overflow-y-auto px-4 pb-4">
            {hits ? (
              <div className="space-y-2">
                {hits.map((h, i) => (
                  <button
                    key={i}
                    type="button"
                    className="block w-full rounded-xl border border-orange-100 bg-white p-3 text-left"
                    onClick={() => openHit(h)}
                  >
                    <div className="mb-1 text-[11px] font-medium text-orange-700">{h.label}</div>
                    <div className="text-xs leading-relaxed text-stone-500">{h.snippet}</div>
                  </button>
                ))}
              </div>
            ) : (
              <>
                {sections && sections.length > 0 ? (
                  <div className="space-y-1.5">
                    {sections.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        className={
                          'block w-full rounded-xl border p-3 text-left ' +
                          (s.kind === 'chapter'
                            ? 'border-orange-100 bg-white'
                            : 'border-transparent bg-orange-50')
                        }
                        onClick={() => openSection(i)}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span
                            className={
                              'min-w-0 flex-1 truncate text-sm ' +
                              (s.kind === 'chapter' ? 'font-medium text-stone-700' : 'text-stone-500')
                            }
                          >
                            {s.kind === 'chapter' ? '' : '§ '}
                            {s.label}
                          </span>
                          <span className="shrink-0 text-[10px] text-stone-400">{s.chars} 字</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : sections && sections.length === 0 ? (
                  <div className="text-center text-xs text-stone-400">
                    这本范文没解析出章节结构（可能是连续文本）。
                    <div className="mt-3 flex justify-center gap-2">
                      {[0, 25, 50, 75, 100].map((p) => (
                        <button
                          key={p}
                          type="button"
                          className="rounded-full border border-orange-200 px-3 py-1 text-xs text-stone-600"
                          onClick={() => pctJump(p)}
                        >
                          {p}%
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-center text-xs text-stone-400">目录加载中…</div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
