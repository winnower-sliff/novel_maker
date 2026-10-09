import { joinChapterContent, splitChapterHeading } from '@shared/chapterContent'
import { groupChapterSegments } from '@shared/chapterSegments'
import type { ContextPart, LintReport } from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type SyntheticEvent, useCallback, useEffect, useState } from 'react'
import { Badge, Button, Card, Textarea } from '../components/ui'
import { fmtTokens } from '../lib/format'
import type { Navigate } from '../lib/nav'
import { qk, queries } from '../lib/queries'

const STATUS_BADGE: Record<string, { label: string; tone: 'default' | 'amber' | 'green' }> = {
  draft: { label: '草稿', tone: 'default' },
  approved: { label: '已审定', tone: 'amber' },
  written: { label: '已定稿', tone: 'green' },
  polished: { label: '已润色', tone: 'green' }
}

interface Props {
  projectId: string
  onNavigate: Navigate
  focusOutlineId: string | null
  onFocusConsumed: () => void
}

export default function Writing({ projectId, onNavigate, focusOutlineId, onFocusConsumed }: Props) {
  const queryClient = useQueryClient()
  const { data: briefs = [] } = useQuery(queries.chapterBriefs(projectId))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [heading, setHeading] = useState('')
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [notice, setNotice] = useState('')
  const [lintReport, setLintReport] = useState<LintReport | null>(null)
  const [ctxPreview, setCtxPreview] = useState<ContextPart[] | null>(null)
  // 侧栏章节按每 20 章分段，折叠态记录「卷:段」key
  const [collapsedSegs, setCollapsedSegs] = useState<Set<string>>(new Set())

  const selected = briefs.find((b) => b.id === selectedId) ?? null

  // 编辑器只持正文（body）；全量文本（含 `## 标题` 行）一律拆分后进入
  const setFromFull = useCallback((full: string): void => {
    const split = splitChapterHeading(full)
    setHeading(split.heading)
    setContent(split.body)
  }, [])

  const loadBriefs = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: qk.chapterBriefs(projectId) })
  }, [projectId, queryClient])

  const openChapter = useCallback(
    (outlineId: string): void => {
      setSelectedId(outlineId)
      setNotice('')
      setLintReport(null)
      setCtxPreview(null)
      void window.api.novel.chapter(outlineId).then((c) => {
        setFromFull(c?.content ?? '')
        setDirty(false)
      })
    },
    [setFromFull]
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId 仅作重置信号
  useEffect(() => {
    setSelectedId(null)
    setHeading('')
    setContent('')
    setNotice('')
    setLintReport(null)
    setCtxPreview(null)
  }, [projectId])

  useEffect(() => {
    if (!focusOutlineId || briefs.length === 0) return
    if (briefs.some((b) => b.id === focusOutlineId)) openChapter(focusOutlineId)
    onFocusConsumed()
  }, [focusOutlineId, briefs, openChapter, onFocusConsumed])

  if (!projectId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-600">
        请先选择一个项目
        <Button onClick={() => onNavigate('projects')}>去选择项目</Button>
      </div>
    )
  }

  const runLint = async (): Promise<void> => {
    if (!selectedId) return
    try {
      const r = (await window.api.lint.run(selectedId, content)) as LintReport
      setLintReport(r)
      setNotice(
        r.pass
          ? `硬闸通过（${r.wordCount} 字）`
          : `硬闸发现 ${r.issues.length} 项问题（本地零成本检查）`
      )
    } catch (err) {
      setNotice(`硬闸检查失败：${(err as Error).message}`)
    }
  }

  const saveDraft = (): void => {
    if (!selectedId) return
    void window.api.novel
      .saveChapter({
        outlineId: selectedId,
        projectId,
        content: joinChapterContent(heading, content)
      })
      .then(() => {
        setDirty(false)
        setNotice('草稿已保存')
        loadBriefs()
      })
  }

  const finalize = (): void => {
    if (!selectedId || !selected) return
    if (content.trim().length === 0) return
    if (dirty && !window.confirm('有未保存的修改，定稿前将先保存当前内容。继续？')) return
    void window.api.novel
      .saveChapter({
        outlineId: selectedId,
        projectId,
        content: joinChapterContent(heading, content),
        status: 'written'
      })
      .then(() => {
        setDirty(false)
        setNotice('已定稿。摘要与人物状态更新可到智能体页让 AI 补齐。')
        loadBriefs()
      })
  }

  const previewContext = (): void => {
    if (!selectedId) return
    void window.api.novel.contextPreview(selectedId).then((ctx) => setCtxPreview(ctx.parts))
  }

  const exportChapter = (format: 'txt' | 'md' | 'docx'): void => {
    if (!selectedId) return
    void window.api.exporter
      .run({ projectId, format, scope: 'single', outlineId: selectedId })
      .then((r) => setNotice(`已导出：${r.path}（${r.words} 字）`))
      .catch((err: unknown) => {
        const msg = (err as Error).message
        if (msg !== '已取消导出') setNotice(`导出失败：${msg}`)
      })
  }

  const closeMenu = (e: SyntheticEvent): void => {
    ;(e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open')
  }

  const wordCount = content.replace(/\s/g, '').length
  const status = selected ? STATUS_BADGE[selected.status] : null
  const volumeGroups = groupChapterSegments(briefs)

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:flex-row md:p-4">
      <Card className="flex max-h-44 shrink-0 flex-col md:max-h-none md:w-60">
        <div className="border-b border-zinc-800 px-3 py-2.5 text-sm font-medium text-zinc-200">
          章节（{briefs.length}）
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {volumeGroups.length === 0 && (
            <div className="space-y-1.5 p-4 text-center text-xs leading-5 text-zinc-600">
              <div>暂无大纲，先去录入章节列表</div>
              <div className="flex flex-col items-center gap-1.5">
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  onClick={() => onNavigate('outline')}
                >
                  去大纲页
                </Button>
              </div>
            </div>
          )}
          {volumeGroups.map(({ volume, segments }) => (
            <div key={volume} className="mb-2">
              <div className="px-2 py-1 text-[10px] font-medium tracking-wider text-zinc-600">
                第 {volume} 卷
              </div>
              {segments.map((seg) => {
                const key = `${volume}:${seg.segNo}`
                const list = seg.chapters
                const from = seg.from
                const to = seg.to
                const collapsed = collapsedSegs.has(key)
                const hasSelected = list.some((b) => b.id === selectedId)
                return (
                  <div key={key}>
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsedSegs((prev) => {
                          const next = new Set(prev)
                          if (next.has(key)) next.delete(key)
                          else next.add(key)
                          return next
                        })
                      }
                      className="flex w-full cursor-pointer items-center gap-1 rounded px-2 py-1 text-left text-[10px] text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300"
                    >
                      <span className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}>
                        ▸
                      </span>
                      第 {from}-{to} 章
                      <span className="ml-auto font-normal text-zinc-700">{list.length}</span>
                    </button>
                    {(!collapsed || hasSelected) &&
                      list.map((b) => (
                        <button
                          type="button"
                          key={b.id}
                          onClick={() => openChapter(b.id)}
                          className={`mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                            selectedId === b.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
                          }`}
                        >
                          <span className="w-7 shrink-0 text-right font-mono text-xs text-zinc-500">
                            {b.chapterNo}
                          </span>
                          <span
                            className={`min-w-0 flex-1 truncate text-xs ${
                              selectedId === b.id ? 'text-zinc-100' : 'text-zinc-300'
                            }`}
                          >
                            {b.title || '未命名'}
                          </span>
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              b.hasDraft ? 'bg-emerald-500' : 'bg-zinc-700'
                            }`}
                            title={b.hasDraft ? `${b.wordCount} 字` : '未写'}
                          />
                        </button>
                      ))}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </Card>

      <Card className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4">
        {selected ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2.5">
              <div className="text-sm font-medium text-zinc-100">
                第 {selected.chapterNo} 章 · {selected.title || '未命名'}
              </div>
              {status && <Badge tone={status.tone}>{status.label}</Badge>}
              {dirty && <Badge tone="amber">未保存</Badge>}
              <span className="text-xs text-zinc-500">{wordCount} 字</span>
              <div className="ml-auto flex min-w-0 gap-2 overflow-x-auto pb-1 [&>*]:shrink-0 md:flex-wrap md:overflow-visible md:pb-0">
                <Button variant="ghost" onClick={saveDraft} disabled={!dirty}>
                  保存
                </Button>
                <Button onClick={finalize} disabled={content.trim().length === 0}>
                  定稿
                </Button>
                <details className="relative">
                  <summary className="inline-flex cursor-pointer list-none items-center rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 [&::-webkit-details-marker]:hidden">
                    更多 ▾
                  </summary>
                  <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded-md border border-zinc-700 bg-zinc-900 p-1 shadow-xl">
                    <button
                      type="button"
                      onClick={(e) => {
                        closeMenu(e)
                        previewContext()
                      }}
                      className="block w-full cursor-pointer rounded px-2.5 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                    >
                      上下文
                    </button>
                    <button
                      type="button"
                      disabled={!content.trim()}
                      onClick={(e) => {
                        closeMenu(e)
                        void runLint()
                      }}
                      className="block w-full cursor-pointer rounded px-2.5 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600"
                    >
                      硬闸
                    </button>
                    <div className="my-1 h-px bg-zinc-800" />
                    {(['txt', 'md', 'docx'] as const).map((f) => (
                      <button
                        type="button"
                        key={f}
                        onClick={(e) => {
                          closeMenu(e)
                          exportChapter(f)
                        }}
                        className="block w-full cursor-pointer rounded px-2.5 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                      >
                        导出 {f}
                      </button>
                    ))}
                  </div>
                </details>
              </div>
            </div>

            <Textarea
              className="min-h-[45vh] shrink-0 leading-8 md:min-h-[55vh]"
              value={content}
              onChange={(e) => {
                setContent(e.target.value)
                setDirty(true)
              }}
              placeholder="直接手写正文；初稿可到智能体页让 AI 生成后回来编辑"
            />

            {lintReport && (
              <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-2">
                <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-300">
                  硬闸检查（本地零成本）
                  <Badge tone={lintReport.pass ? 'green' : 'red'}>
                    {lintReport.pass ? '通过' : `${lintReport.issues.length} 项`}
                  </Badge>
                  <span className="text-zinc-500">
                    {lintReport.wordCount} 字
                    {lintReport.targetWords ? ` / 目标 ${lintReport.targetWords}` : ''}
                  </span>
                  <button
                    type="button"
                    className="ml-auto cursor-pointer text-zinc-500 hover:text-zinc-300"
                    onClick={() => setLintReport(null)}
                  >
                    关闭
                  </button>
                </div>
                {lintReport.issues.length === 0 && (
                  <div className="text-xs text-emerald-400">接缝、穿帮词、重复段、字数均正常</div>
                )}
                {lintReport.issues.map((iss, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 追加式/一次性渲染列表，index 即身份，无重排语义
                  <div key={i} className="mb-1.5 border-l-2 border-zinc-700 pl-2 text-xs leading-5">
                    <span
                      className={`mr-2 rounded px-1.5 py-0.5 text-[10px] ${
                        iss.level === 'major'
                          ? 'bg-red-900/50 text-red-300'
                          : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {iss.rule}
                    </span>
                    <span className="text-zinc-400">{iss.advice}</span>
                    {iss.quote && <div className="text-zinc-600">原文：{iss.quote}</div>}
                  </div>
                ))}
              </div>
            )}

            {notice && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                <span className="text-zinc-300">{notice}</span>
              </div>
            )}

            {ctxPreview && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
                  写作上下文构成
                </summary>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {ctxPreview.map((p) => (
                    <span
                      key={p.name}
                      className="rounded bg-zinc-800/80 px-2 py-1 text-[11px] text-zinc-400"
                    >
                      {p.name} · {p.detail} ·{' '}
                      <span className="font-mono">{fmtTokens(p.tokens)}t</span>
                    </span>
                  ))}
                </div>
              </details>
            )}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-600">
            <span>左侧选择一章开始写作</span>
            <span className="text-xs">初稿可到智能体页让 AI 生成；此处负责编辑、定稿与导出</span>
          </div>
        )}
      </Card>
    </div>
  )
}
