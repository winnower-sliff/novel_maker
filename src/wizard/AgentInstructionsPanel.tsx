import type { AgentInstructionsView, RuleSectionView } from '@shared/types'
import { type ReactNode, useEffect, useState } from 'react'
import { OverlayCard } from './OverlayCard'

const INPUT_CLS =
  'rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600 disabled:opacity-50'
const BTN_CLS =
  'cursor-pointer rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800/60 active:bg-zinc-800 disabled:cursor-default disabled:opacity-40'
const TEXTAREA_CLS =
  'w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs leading-5 text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600 disabled:opacity-50'
const SAVE_CLS =
  'cursor-pointer rounded-md bg-amber-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 disabled:cursor-default disabled:opacity-40'
const DEL_CLS =
  'cursor-pointer rounded-md border border-red-900/60 px-2 py-1 text-xs text-red-400/90 hover:bg-red-950/40 disabled:cursor-default disabled:opacity-40'

const TAG_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '无标签（每次注入）' },
  { value: 'core', label: '[core] 每次注入' },
  { value: 'outline', label: '[outline] 生成大纲' },
  { value: 'chapter', label: '[chapter] 写正文' },
  { value: 'prose', label: '[prose] 文笔' },
  { value: 'dialogue', label: '[dialogue] 对话' },
  { value: 'hooks', label: '[hooks] 章末钩子' },
  { value: 'plot', label: '[plot] 剧情' },
  { value: 'fore', label: '[fore] 伏笔' },
  { value: 'character', label: '[character] 人物' },
  { value: 'worldbuild', label: '[worldbuild] 世界观' },
  { value: 'continuity', label: '[continuity] 连贯性' }
]

const sanitizeTag = (raw: string): string => raw.toLowerCase().replace(/[^a-z0-9_-]/g, '')

const injectHint = (tag: string | null): string =>
  !tag || tag === 'core' ? '每次任务注入' : `随 [${tag}] 任务注入`

type Tab = 'global' | 'project'

interface Draft {
  originalTitle: string | null
  title: string
  tag: string
  body: string
}

function SectionCardBody({
  body,
  renderMarkdown
}: {
  body: string
  renderMarkdown?: (md: string) => ReactNode
}) {
  if (!body.trim()) {
    return <div className="text-xs text-zinc-600">（空）</div>
  }
  if (renderMarkdown) return <div className="text-sm">{renderMarkdown(body)}</div>
  return <div className="whitespace-pre-wrap text-xs leading-5 text-zinc-300">{body}</div>
}

export function AgentInstructionsPanel({
  projectId,
  renderMarkdown
}: {
  projectId: string
  renderMarkdown?: (md: string) => ReactNode
}) {
  const [view, setView] = useState<AgentInstructionsView | null>(null)
  const [tab, setTab] = useState<Tab>('global')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [preambleDraft, setPreambleDraft] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void window.api.agent
      .instructionsGet(projectId)
      .then((v) => {
        if (alive) setView(v)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId])

  const preamble = view ? (tab === 'global' ? view.globalPreamble : view.projectPreamble) : ''
  const sections: RuleSectionView[] = view
    ? tab === 'global'
      ? view.globalSections
      : view.projectSections
    : []

  const openNew = (): void => {
    setError('')
    setConfirmDel(false)
    setDraft({ originalTitle: null, title: '', tag: '', body: '' })
  }

  const openSection = (s: RuleSectionView): void => {
    setError('')
    setConfirmDel(false)
    setDraft({ originalTitle: s.title, title: s.title, tag: s.tag ?? '', body: s.body })
  }

  const closeEditor = (): void => {
    setDraft(null)
    setConfirmDel(false)
    setError('')
  }

  const saveSection = async (): Promise<void> => {
    if (!draft || saving) return
    const title = draft.title.trim()
    if (!title) {
      setError('标题不能为空')
      return
    }
    if (
      draft.originalTitle === null &&
      sections.some((s) => s.title.toLowerCase() === title.toLowerCase())
    ) {
      setError('已存在同名节，请换标题或直接编辑该节')
      return
    }
    if (!draft.body.trim()) {
      setError('正文不能为空（删除请用删除按钮）')
      return
    }
    setSaving(true)
    setError('')
    try {
      const next = await window.api.agent.instructionSectionSave({
        kind: 'section',
        scope: tab,
        projectId,
        title,
        body: draft.body,
        tag: draft.tag ? sanitizeTag(draft.tag) : null
      })
      setView(next)
      closeEditor()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const deleteSection = async (): Promise<void> => {
    if (!draft?.originalTitle || saving) return
    setSaving(true)
    setError('')
    try {
      const next = await window.api.agent.instructionSectionSave({
        kind: 'section',
        scope: tab,
        projectId,
        title: draft.originalTitle,
        body: '',
        tag: null
      })
      setView(next)
      closeEditor()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const savePreamble = async (): Promise<void> => {
    if (preambleDraft === null || saving) return
    setSaving(true)
    setError('')
    try {
      const next = await window.api.agent.instructionSectionSave({
        kind: 'preamble',
        scope: tab,
        projectId,
        text: preambleDraft
      })
      setView(next)
      setPreambleDraft(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const tabBtn = (key: Tab, label: string): ReactNode => (
    <button
      key={key}
      type="button"
      className={`cursor-pointer rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-40 ${
        tab === key
          ? 'border-amber-600/60 bg-amber-600/10 text-amber-400'
          : 'border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
      }`}
      onClick={() => setTab(key)}
    >
      {label}
    </button>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {tabBtn('global', '全局')}
        {tabBtn('project', '本项目')}
        <span className="text-[11px] text-zinc-600">
          {tab === 'global'
            ? `存于 ${view?.globalPath ?? 'agents.md'}，所有项目生效；按 [tag] 分节注入，无标签/[core] 每次注入`
            : '仅当前项目的智能体生效，优先级高于全局'}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-xs font-medium text-zinc-300">开头段</span>
            <span className="text-[11px] text-zinc-600">每次任务注入</span>
            <button
              type="button"
              className={`${BTN_CLS} ml-auto`}
              onClick={() => {
                setError('')
                setPreambleDraft(preamble)
              }}
            >
              编辑
            </button>
          </div>
          <SectionCardBody body={preamble} renderMarkdown={renderMarkdown} />
        </div>

        {sections.map((s) => (
          <div key={s.title} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-zinc-300">{s.title}</span>
              <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-400">
                {injectHint(s.tag)}
              </span>
              <button type="button" className={`${BTN_CLS} ml-auto`} onClick={() => openSection(s)}>
                编辑
              </button>
            </div>
            <SectionCardBody body={s.body} renderMarkdown={renderMarkdown} />
          </div>
        ))}

        {sections.length === 0 && !preamble.trim() && (
          <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-600">
            暂无指令——点「＋ 新增节」手写，或到智能体对话让 AI 起草
          </div>
        )}

        <button type="button" className={`${BTN_CLS} w-full`} onClick={openNew}>
          ＋ 新增节
        </button>
      </div>

      <OverlayCard
        open={draft !== null}
        onClose={closeEditor}
        title={draft?.originalTitle ? `编辑节：${draft.originalTitle}` : '新增节'}
        widthClass="max-w-2xl"
        footer={
          <div className="flex w-full flex-wrap items-center gap-2">
            {error && <span className="text-xs text-red-400/90">{error}</span>}
            {draft?.originalTitle && (
              <button
                type="button"
                className={`${DEL_CLS} mr-auto`}
                disabled={saving}
                onClick={() => {
                  if (!confirmDel) {
                    setConfirmDel(true)
                    return
                  }
                  void deleteSection()
                }}
              >
                {confirmDel ? '确认删除？' : '删除'}
              </button>
            )}
            <button type="button" className={BTN_CLS} disabled={saving} onClick={closeEditor}>
              取消
            </button>
            <button
              type="button"
              className={SAVE_CLS}
              disabled={saving}
              onClick={() => void saveSection()}
            >
              保存
            </button>
          </div>
        }
      >
        {draft && (
          <div className="space-y-2.5">
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <span className="w-12 shrink-0">标题</span>
              <input
                className={`${INPUT_CLS} flex-1`}
                value={draft.title}
                disabled={saving || draft.originalTitle !== null}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="如：叙事纪律"
              />
            </label>
            <div className="flex items-start gap-2 text-xs text-zinc-400">
              <span className="w-12 shrink-0 pt-1.5">标签</span>
              <div className="flex-1 space-y-1.5">
                <div className="flex flex-wrap gap-1">
                  {TAG_OPTIONS.map((o) => (
                    <button
                      key={o.value || 'none'}
                      type="button"
                      disabled={saving}
                      onClick={() => setDraft({ ...draft, tag: o.value })}
                      className={`cursor-pointer rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-default disabled:opacity-40 ${
                        (draft.tag || '') === o.value
                          ? 'border-amber-600/60 bg-amber-600/10 text-amber-400'
                          : 'border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <input
                  className={`${INPUT_CLS} w-full`}
                  value={draft.tag}
                  disabled={saving}
                  onChange={(e) => setDraft({ ...draft, tag: sanitizeTag(e.target.value) })}
                  placeholder="或输入自定义标签（a-z 0-9 _ -）"
                />
              </div>
            </div>
            <div className="flex items-start gap-2 text-xs text-zinc-400">
              <span className="w-12 shrink-0 pt-1.5">正文</span>
              <textarea
                className={`${TEXTAREA_CLS} min-h-56 flex-1`}
                value={draft.body}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                placeholder="markdown；支持 [[条目|关系]] 链接。留空不可保存，删除请用删除按钮。"
              />
            </div>
          </div>
        )}
      </OverlayCard>

      <OverlayCard
        open={preambleDraft !== null}
        onClose={() => {
          setPreambleDraft(null)
          setError('')
        }}
        title="编辑开头段"
        widthClass="max-w-2xl"
        footer={
          <div className="flex w-full items-center gap-2">
            {error && <span className="text-xs text-red-400/90">{error}</span>}
            <button
              type="button"
              className={`${BTN_CLS} ml-auto`}
              disabled={saving}
              onClick={() => setPreambleDraft(null)}
            >
              取消
            </button>
            <button
              type="button"
              className={SAVE_CLS}
              disabled={saving}
              onClick={() => void savePreamble()}
            >
              保存
            </button>
          </div>
        }
      >
        <textarea
          className={`${TEXTAREA_CLS} min-h-56`}
          value={preambleDraft ?? ''}
          disabled={saving}
          onChange={(e) => setPreambleDraft(e.target.value)}
          placeholder="写给智能体的总原则（每次任务注入）；按 [tag] 分节的细则请用下方分节管理。"
        />
      </OverlayCard>
    </div>
  )
}
