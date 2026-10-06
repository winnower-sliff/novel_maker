import type { AgentInstructionsView, RuleSectionView } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { generateInstructionRefine, generateInstructionSuggest } from './agentGen'

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

const INPUT_CLS =
  'rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600 disabled:opacity-50'
const BTN_CLS =
  'cursor-pointer rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800/60 active:bg-zinc-800 disabled:cursor-default disabled:opacity-40'
const TEXTAREA_CLS =
  'w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs leading-5 text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600 disabled:opacity-50'

/** 与主进程解析器一致：标签只允许 ASCII（中文/非法字符清掉，空则退化为无标签） */
function sanitizeTag(tag: string | null): string | null {
  if (!tag) return null
  const t = tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
  return t || null
}

function serializeSections(preamble: string, sections: RuleSectionView[]): string {
  const body = sections
    .map((s) => {
      const title = s.title.trim() || '未命名节'
      const tag = sanitizeTag(s.tag)
      const line = tag ? `## ${title} [${tag}]` : `## ${title}`
      const text = s.body.trim()
      return text ? `${line}\n${text}` : line
    })
    .join('\n\n')
  return [preamble.trim(), body].filter(Boolean).join('\n\n')
}

/** 带本地稳定 key 的编辑态节（序列化时多余字段被忽略） */
interface EditSection extends RuleSectionView {
  _id: string
}

let seq = 0
function withIds(list: RuleSectionView[]): EditSection[] {
  return list.map((s) => ({ ...s, _id: `sec${++seq}` }))
}

const toMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function SectionTagEditor({
  value,
  onChange,
  disabled
}: {
  value: string | null
  onChange: (v: string | null) => void
  disabled: boolean
}) {
  const isPreset = value === null || TAG_OPTIONS.some((o) => o.value === value)
  const [custom, setCustom] = useState(!isPreset)
  return (
    <div className="flex items-center gap-1">
      <select
        value={custom ? '__custom' : (value ?? '')}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value
          if (v === '__custom') {
            setCustom(true)
          } else {
            setCustom(false)
            onChange(v === '' ? null : v)
          }
        }}
        className={`${INPUT_CLS} cursor-pointer`}
      >
        {TAG_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value="__custom">自定义…</option>
      </select>
      {custom && (
        <input
          value={value ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(sanitizeTag(e.target.value))}
          placeholder="tag"
          className={`${INPUT_CLS} w-20`}
        />
      )}
    </div>
  )
}

function SectionCard({
  section,
  index,
  count,
  disabled,
  refining,
  onPatch,
  onRemove,
  onMove,
  onRefine
}: {
  section: EditSection
  index: number
  count: number
  disabled: boolean
  refining: boolean
  onPatch: (patch: Partial<RuleSectionView>) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
  onRefine: () => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? '收起' : '展开'}
          className="cursor-pointer text-xs text-zinc-500"
        >
          <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        </button>
        <input
          value={section.title}
          onChange={(e) => onPatch({ title: e.target.value })}
          disabled={disabled}
          placeholder="节标题"
          className={`${INPUT_CLS} min-w-0 flex-1`}
        />
        <SectionTagEditor
          value={section.tag}
          onChange={(t) => onPatch({ tag: t })}
          disabled={disabled}
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={disabled || index === 0}
            aria-label="上移"
            className={BTN_CLS}
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={disabled || index === count - 1}
            aria-label="下移"
            className={BTN_CLS}
          >
            ↓
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            aria-label="删除"
            className="cursor-pointer rounded-md border border-red-900/60 px-2 py-1 text-xs text-red-400/90 hover:bg-red-950/40 disabled:cursor-default disabled:opacity-40"
          >
            ✕
          </button>
        </div>
      </div>
      {open && (
        <div className="border-t border-zinc-800/70 px-2.5 py-2">
          <textarea
            value={section.body}
            onChange={(e) => onPatch({ body: e.target.value })}
            disabled={disabled}
            rows={4}
            placeholder={'规则内容，例如：\n- 每章结尾留一个钩子'}
            className={TEXTAREA_CLS}
          />
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <span className="text-[11px] text-zinc-600">
              {!section.tag || section.tag === 'core'
                ? '每次任务注入'
                : `随 [${section.tag}] 任务注入`}
            </span>
            <button type="button" onClick={onRefine} disabled={disabled} className={BTN_CLS}>
              {refining ? '优化中…' : 'AI 优化'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function PreambleCard({
  value,
  onChange,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-2 text-left"
      >
        <span
          className={`inline-block text-xs text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}
        >
          ▸
        </span>
        <span className="text-xs text-zinc-400">文件头（## 分节之前的内容，每次注入）</span>
      </button>
      {open && (
        <div className="border-t border-zinc-800/70 px-2.5 py-2">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            rows={3}
            placeholder="文件说明…（可留空）"
            className={TEXTAREA_CLS}
          />
        </div>
      )}
    </div>
  )
}

/** 智能体指令弹层内容（两端共用）：全局结构化分节编辑 + 项目纯文本，均带 AI 优化/建议 */
export function AgentInstructionsPanel({ projectId }: { projectId: string }) {
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [tab, setTab] = useState<'global' | 'project'>('global')
  const [view, setView] = useState<AgentInstructionsView | null>(null)
  const [preamble, setPreamble] = useState('')
  const [sections, setSections] = useState<EditSection[]>([])
  const [projectDraft, setProjectDraft] = useState('')
  const [baselineG, setBaselineG] = useState('')
  const [baselineP, setBaselineP] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')
  const [aiBusy, setAiBusy] = useState<string | null>(null)
  const [aiTail, setAiTail] = useState('')
  const abortRef = useRef<(() => void) | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey 仅作重试触发
  useEffect(() => {
    let stopped = false
    setLoading(true)
    setErr('')
    void window.api.agent
      .instructionsGet(projectId)
      .then((v) => {
        if (stopped) return
        setView(v)
        setPreamble(v.globalPreamble)
        setSections(withIds(v.globalSections))
        setBaselineG(serializeSections(v.globalPreamble, v.globalSections))
        setProjectDraft(v.projectText)
        setBaselineP(v.projectText)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (stopped) return
        setErr(toMsg(e))
        setLoading(false)
      })
    return () => {
      stopped = true
    }
  }, [projectId, reloadKey])

  // 卸载时中止在途 AI 请求（关弹层即停，避免白烧 token）
  useEffect(() => {
    return () => {
      abortRef.current?.()
      abortRef.current = null
    }
  }, [])

  const dirtyG = serializeSections(preamble, sections) !== baselineG
  const dirtyP = projectDraft !== baselineP
  const dirty = tab === 'global' ? dirtyG : dirtyP
  const locked = !!aiBusy || saving

  const patchSection = (i: number, patch: Partial<RuleSectionView>): void => {
    setSections((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)))
    setSaved(false)
  }

  const addSection = (): void => {
    if (locked) return
    setSections((prev) => [...prev, ...withIds([{ title: '', tag: null, body: '' }])])
    setSaved(false)
  }

  const removeSection = (i: number): void => {
    if (locked) return
    if (!window.confirm('删除该节？保存后生效')) return
    setSections((prev) => prev.filter((_, j) => j !== i))
    setSaved(false)
  }

  const moveSection = (i: number, dir: -1 | 1): void => {
    if (locked) return
    setSections((prev) => {
      const j = i + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      const tmp = next[i]
      next[i] = next[j]
      next[j] = tmp
      return next
    })
    setSaved(false)
  }

  const runRefine = (scope: 'global' | 'project', secIndex: number | null): void => {
    if (locked) return
    setErr('')
    setSaved(false)
    if (scope === 'project') {
      const original = projectDraft
      setAiBusy('refine-project')
      setProjectDraft('')
      const { done, abort } = generateInstructionRefine({
        projectId,
        scope: 'project',
        text: original,
        onDelta: (t) => setProjectDraft((v) => v + t)
      })
      abortRef.current = abort
      void done
        .then((text) => setProjectDraft(text))
        .catch((e: unknown) => {
          setProjectDraft(original)
          setErr(toMsg(e))
        })
        .finally(() => {
          abortRef.current = null
          setAiBusy(null)
        })
      return
    }
    if (secIndex === null) return
    const idx = secIndex
    const sec = sections[idx]
    if (!sec) return
    const original = sec.body
    setAiBusy(`refine-${idx}`)
    setSections((prev) => prev.map((s, j) => (j === idx ? { ...s, body: '' } : s)))
    const { done, abort } = generateInstructionRefine({
      projectId,
      scope: 'global',
      text: original,
      title: sec.title,
      tag: sec.tag,
      onDelta: (t) =>
        setSections((prev) => prev.map((s, j) => (j === idx ? { ...s, body: s.body + t } : s)))
    })
    abortRef.current = abort
    void done
      .then((text) =>
        setSections((prev) => prev.map((s, j) => (j === idx ? { ...s, body: text } : s)))
      )
      .catch((e: unknown) => {
        setSections((prev) => prev.map((s, j) => (j === idx ? { ...s, body: original } : s)))
        setErr(toMsg(e))
      })
      .finally(() => {
        abortRef.current = null
        setAiBusy(null)
      })
  }

  const runSuggest = (scope: 'global' | 'project'): void => {
    if (locked) return
    setErr('')
    setSaved(false)
    setAiBusy(`suggest-${scope}`)
    setAiTail('')
    const { done, abort } = generateInstructionSuggest({
      projectId,
      scope,
      onDelta: (t) => setAiTail((v) => (v + t).slice(-500))
    })
    abortRef.current = abort
    void done
      .then((res) => {
        if (scope === 'global') {
          setSections(withIds(res.sections ?? []))
        } else {
          setProjectDraft(res.text)
        }
      })
      .catch((e: unknown) => setErr(toMsg(e)))
      .finally(() => {
        abortRef.current = null
        setAiBusy(null)
        setAiTail('')
      })
  }

  const save = (): void => {
    if (!view || locked) return
    setSaving(true)
    setSaved(false)
    setErr('')
    const scope = tab
    const text = scope === 'global' ? serializeSections(preamble, sections) : projectDraft
    void window.api.agent
      .instructionsSave(scope, text, projectId)
      .then(() => {
        setSaving(false)
        setSaved(true)
        if (scope === 'global') {
          setBaselineG(text)
          setView((v) => (v ? { ...v, globalText: text } : v))
        } else {
          setBaselineP(text)
          setView((v) => (v ? { ...v, projectText: text } : v))
        }
      })
      .catch((e: unknown) => {
        setSaving(false)
        setErr(toMsg(e))
      })
  }

  if (loading) {
    return <div className="py-10 text-center text-xs text-zinc-500">加载中…</div>
  }
  if (!view) {
    return (
      <div className="flex flex-col items-center gap-2 py-10">
        <p className="text-xs text-red-400">{err || '加载失败'}</p>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)} className={BTN_CLS}>
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {(
          [
            ['global', '全局（agents.md）'],
            ['project', '本项目']
          ] as Array<['global' | 'project', string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            disabled={locked}
            onClick={() => {
              setTab(key)
              setSaved(false)
              setErr('')
            }}
            className={`cursor-pointer rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-40 ${
              tab === key
                ? 'border-amber-600/60 bg-amber-600/10 text-amber-400'
                : 'border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-4 text-zinc-600">
        {tab === 'global'
          ? `存于 ${view.globalPath}，所有项目生效；按 [tag] 分节注入，无标签/[core] 每次注入`
          : '仅当前项目的智能体生效，优先级高于全局'}
      </p>
      {tab === 'global' ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button type="button" onClick={addSection} disabled={locked} className={BTN_CLS}>
              ＋ 添加节
            </button>
            <button
              type="button"
              onClick={() => runSuggest('global')}
              disabled={locked}
              className={`ml-auto ${BTN_CLS}`}
            >
              {aiBusy === 'suggest-global' ? '起草中…' : 'AI 建议'}
            </button>
          </div>
          {aiBusy === 'suggest-global' && (
            <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-500">
              {aiTail || '正在阅读项目设定起草规则…'}
            </pre>
          )}
          <PreambleCard
            value={preamble}
            onChange={(v) => {
              setPreamble(v)
              setSaved(false)
            }}
            disabled={locked}
          />
          {sections.map((s, i) => (
            <SectionCard
              key={s._id}
              section={s}
              index={i}
              count={sections.length}
              disabled={locked}
              refining={aiBusy === `refine-${i}`}
              onPatch={(p) => patchSection(i, p)}
              onRemove={() => removeSection(i)}
              onMove={(d) => moveSection(i, d)}
              onRefine={() => runRefine('global', i)}
            />
          ))}
          {sections.length === 0 && (
            <p className="py-2 text-center text-xs text-zinc-600">
              暂无分节——点「＋ 添加节」或「AI 建议」起草
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            rows={12}
            value={projectDraft}
            onChange={(e) => {
              setProjectDraft(e.target.value)
              setSaved(false)
            }}
            disabled={locked}
            placeholder="本项目专属的工作要求，例如「伏笔必须三章内回收」「主角称呼固定为『阿澈』」…（Markdown）"
            className={`${TEXTAREA_CLS} font-mono`}
          />
          {aiBusy === 'suggest-project' && (
            <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-500">
              {aiTail || '正在起草…'}
            </pre>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => runRefine('project', null)}
              disabled={locked}
              className={BTN_CLS}
            >
              {aiBusy === 'refine-project' ? '优化中…' : 'AI 优化'}
            </button>
            <button
              type="button"
              onClick={() => runSuggest('project')}
              disabled={locked}
              className={BTN_CLS}
            >
              {aiBusy === 'suggest-project' ? '起草中…' : 'AI 建议'}
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={locked || !dirty}
          className="cursor-pointer rounded-md bg-amber-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 disabled:cursor-default disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {saved && <span className="text-xs text-emerald-400">已保存，下次任务生效</span>}
        {!saved && dirty && !aiBusy && <span className="text-xs text-zinc-500">有未保存修改</span>}
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>
    </div>
  )
}
