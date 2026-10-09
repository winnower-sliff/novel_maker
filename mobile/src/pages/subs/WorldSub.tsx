import { Button, Empty, Input, Label, Spinner, Textarea } from '@mobile/components/ui'
import { Markdown } from '@mobile/components/Markdown'
import { DetailShell, Row } from '@mobile/pages/subs/parts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { withSnapshot } from '@mobile/lib/querySnapshot'
import { qk } from '@renderer/lib/queries'
import { splitTags } from '@shared/tags'
import type { WorldbuildEntry } from '@shared/types'

/** 剥掉 markdown/[[链接]] 语法后的内容摘要（列表行预览用） */
function plainSummary(content: string): string {
  return content
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[#>*`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

/** 世界观子页：搜索 + 分类 tab + 分组折叠浏览；AI 生成收起为入口，点开才展开表单 */
export default function WorldSub({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: list = [], isLoading } = useQuery({
    queryKey: qk.worldbuild(projectId),
    queryFn: withSnapshot(qk.worldbuild(projectId), () =>
      window.api.novel.worldbuild(projectId)
    )
  })
  const [editId, setEditId] = useState<string | null>(null)
  const editing = list.find((w) => w.id === editId) ?? null

  // —— 浏览态：搜索词 / 分类过滤 / 组折叠记忆（会话内）——
  const [q, setQ] = useState('')
  const deferredQ = useDeferredValue(q)
  const [cat, setCat] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const searching = deferredQ.trim() !== ''

  const [typeOptions, setTypeOptions] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    void window.api.novel
      .worldbuildTypes(projectId)
      .then((types) => {
        if (!alive) return
        setTypeOptions(types)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId])

  // 分类顺序：受控类型表优先，列表中存在但类型表没有的排后
  const categories = useMemo(() => {
    const inList = [...new Set(list.map((w) => w.category))]
    return [...typeOptions.filter((t) => inList.includes(t)), ...inList.filter((c) => !typeOptions.includes(c))]
  }, [list, typeOptions])

  // 分类 tab 选中值可能因条目删除而失效，渲染层回退「全部」
  const activeCat = cat && categories.includes(cat) ? cat : ''

  const countByCat = useMemo(() => {
    const m: Record<string, number> = {}
    for (const w of list) m[w.category] = (m[w.category] ?? 0) + 1
    return m
  }, [list])

  // 全文搜索：标题命中 > 标签/别名 > 内容；搜索词优先于分类 tab
  const searched = useMemo(() => {
    const needle = deferredQ.trim().toLowerCase()
    if (!needle) return null
    const scored: { w: WorldbuildEntry; score: number }[] = []
    for (const w of list) {
      let score = -1
      if (w.title.toLowerCase().includes(needle)) score = 0
      else if (`${w.tags} ${w.keys}`.toLowerCase().includes(needle)) score = 1
      else if (w.content.toLowerCase().includes(needle)) score = 2
      if (score >= 0) scored.push({ w, score })
    }
    return scored.sort((a, b) => a.score - b.score).map((s) => s.w)
  }, [list, deferredQ])



  if (editing)
    return (
      <WorldEditor
        key={editing.id}
        projectId={projectId}
        entry={editing}
        onBack={() => setEditId(null)}
        onSaved={() => void qc.invalidateQueries({ queryKey: qk.worldbuild(projectId) })}
      />
    )

  const entryRow = (w: WorldbuildEntry) => (
    <Row
      key={w.id}
      title={w.title}
      sub={plainSummary(w.content) || undefined}
      right={
        w.tags ? (
          <span className="max-w-24 shrink-0 truncate text-[10px] text-zinc-600">{w.tags}</span>
        ) : undefined
      }
      onClick={() => setEditId(w.id)}
    />
  )

  const catChip = (key: string, label: string, n: number) => (
    <button
      type="button"
      key={key}
      onClick={() => setCat(key)}
      className={`shrink-0 cursor-pointer rounded-full px-2.5 py-1 text-xs transition-colors ${
        activeCat === key ? 'bg-amber-600/20 text-amber-300' : 'bg-zinc-800 text-zinc-400'
      }`}
    >
      {label} {n}
    </button>
  )

  return (
    <div className="flex h-full flex-col">
      {/* 固定头部：搜索框 + 分类 tab */}
      <div className="space-y-2 border-b border-zinc-800 bg-zinc-950/95 px-3 py-2">
        <div className="relative">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索标题 / 标签 / 内容"
            inputMode="search"
            className="pr-8"
          />
          {q && (
            <button
              type="button"
              aria-label="清空搜索"
              className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer text-xs text-zinc-500"
              onClick={() => setQ('')}
            >
              ✕
            </button>
          )}
        </div>
        <div
          className={`flex gap-1.5 overflow-x-auto pb-0.5 ${searching ? 'pointer-events-none opacity-40' : ''}`}
        >
          {catChip('', '全部', list.length)}
          {categories.map((c) => catChip(c, c, countByCat[c] ?? 0))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">

        {/* 条目列表 */}
        {isLoading ? (
          <Empty text="加载中…" />
        ) : list.length === 0 ? (
          <Empty text="暂无世界观条目" />
        ) : searching && searched ? (
          searched.length === 0 ? (
            <Empty text="无匹配条目" />
          ) : (
            <>
              <div className="mb-1.5 px-1 text-xs text-zinc-500">命中 {searched.length} 条</div>
              <div className="space-y-1.5">{searched.map(entryRow)}</div>
            </>
          )
        ) : activeCat ? (
          <div className="space-y-1.5">
            {list.filter((w) => w.category === activeCat).map(entryRow)}
          </div>
        ) : (
          <div className="space-y-4">
            {categories.map((c) => {
              const items = list.filter((w) => w.category === c)
              const fold = collapsed[c] ?? false
              return (
                <div key={c}>
                  <button
                    type="button"
                    className="mb-1.5 flex w-full cursor-pointer items-center gap-1.5 px-1 text-xs font-medium text-zinc-500"
                    onClick={() => setCollapsed((prev) => ({ ...prev, [c]: !fold }))}
                  >
                    <span className={`inline-block transition-transform ${fold ? '' : 'rotate-90'}`}>
                      ▸
                    </span>
                    <span>{c}</span>
                    <span className="text-zinc-700">{items.length}</span>
                  </button>
                  {!fold && <div className="space-y-1.5">{items.map(entryRow)}</div>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

interface SectionDraft {
  id?: string
  title: string
  content: string
}

interface WorldFields {
  title: string
  tags: string
  relation: string
}

const toWorldFields = (w: WorldbuildEntry): WorldFields => ({
  title: w.title,
  tags: w.tags,
  relation: w.relation
})

function WorldEditor({
  projectId,
  entry,
  onBack,
  onSaved
}: {
  projectId: string
  entry: WorldbuildEntry
  onBack: () => void
  onSaved: () => void
}) {
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [fields, setFields] = useState<WorldFields>(() => toWorldFields(entry))
  const baseRef = useRef<WorldFields>(toWorldFields(entry))
  // 分节是存储事实源：view 模式只渲染合并视图 content，进入 edit 才拉分节编辑
  const [sections, setSections] = useState<SectionDraft[]>([])
  const secsBaseRef = useRef<SectionDraft[] | null>(null)
  const [secsLoaded, setSecsLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (mode !== 'edit' || secsLoaded) return
    let alive = true
    void window.api.novel
      .sections('worldbuild', projectId, entry.id)
      .then((secs) => {
        if (!alive) return
        const drafts = secs.map((s) => ({ id: s.id, title: s.title, content: s.content }))
        setSections(drafts)
        secsBaseRef.current = drafts
        setSecsLoaded(true)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [mode, secsLoaded, projectId, entry.id])

  const dirty =
    fields.title !== baseRef.current.title ||
    fields.tags !== baseRef.current.tags ||
    fields.relation !== baseRef.current.relation
  const secsDirty =
    secsBaseRef.current !== null &&
    JSON.stringify(sections) !== JSON.stringify(secsBaseRef.current)
  const anyDirty = dirty || secsDirty
  const tags = splitTags(fields.tags)
  const patch = (p: Partial<WorldFields>): void => setFields((f) => ({ ...f, ...p }))

  const save = async (): Promise<void> => {
    if (!fields.title.trim() || saving) return
    setSaving(true)
    try {
      const clean = sections
        .filter((s) => s.title.trim() || s.content.trim())
        .map((s) => ({ id: s.id, title: s.title.trim(), content: s.content }))
      const saved = await window.api.novel.worldbuildSave({
        id: entry.id,
        projectId,
        category: entry.category,
        title: fields.title,
        tags: fields.tags,
        sections: clean,
        relation: fields.relation
      })
      onSaved()
      const nextFields = toWorldFields(saved)
      setFields(nextFields)
      baseRef.current = nextFields
      // 分节基线作废：下次进编辑重拉，取服务端生成的真实分节 id（clean 里新增节没有 id）
      setSections([])
      secsBaseRef.current = null
      setSecsLoaded(false)
      setMode('view')
    } finally {
      setSaving(false)
    }
  }

  const cancelEdit = (): void => {
    if (anyDirty && !window.confirm('放弃未保存的修改？')) return
    setFields({ ...baseRef.current })
    setSections(secsBaseRef.current ?? [])
    setMode('view')
  }

  const leave = (): void => {
    if (mode === 'edit') {
      cancelEdit()
      return
    }
    onBack()
  }

  const del = async (): Promise<void> => {
    if (saving || deleting) return
    if (!window.confirm(`删除「${fields.title || entry.title}」？此操作不可恢复`)) return
    setDeleting(true)
    try {
      await window.api.novel.worldbuildDelete(entry.id)
      onSaved()
      onBack()
    } finally {
      setDeleting(false)
    }
  }

  const bar =
    mode === 'view' ? (
      <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <span className="text-xs text-zinc-600">只读浏览</span>
        <Button className="ml-auto px-5 py-1.5 text-xs" onClick={() => setMode('edit')}>
          编辑
        </Button>
      </div>
    ) : (
      <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Button
          variant="ghost"
          className="px-2 py-1.5 text-xs text-red-400/90"
          disabled={deleting || saving}
          onClick={() => void del()}
        >
          {deleting ? <Spinner className="h-3.5 w-3.5" /> : '删除'}
        </Button>
        <span className="text-xs text-zinc-600">{anyDirty ? '有未保存修改' : '已保存'}</span>
        <Button
          variant="ghost"
          className="ml-auto px-3.5 py-1.5 text-xs"
          disabled={saving}
          onClick={cancelEdit}
        >
          取消
        </Button>
        <Button
          className="px-3.5 py-1.5 text-xs"
          disabled={!anyDirty || saving || !fields.title.trim()}
          onClick={() => void save()}
        >
          {saving ? <Spinner className="h-3.5 w-3.5" /> : '保存'}
        </Button>
      </div>
    )

  return (
    <DetailShell title={fields.title || entry.title} onBack={leave} dirty={false} bar={bar}>
      {mode === 'view' ? (
        <>
          {(entry.category || tags.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {entry.category && (
                <span className="rounded-full bg-amber-600/20 px-2.5 py-0.5 text-xs text-amber-300">
                  {entry.category}
                </span>
              )}
              {tags.map((t) => (
                <span key={t} className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-400">
                  {t}
                </span>
              ))}
            </div>
          )}
          {entry.content.trim() ? (
            <section>
              <Label>内容</Label>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                <Markdown text={entry.content} className="text-sm leading-6 text-zinc-200" />
              </div>
            </section>
          ) : (
            <div className="text-xs text-zinc-600">尚无内容，点右下角「编辑」补充</div>
          )}
          {fields.relation.trim() ? (
            <section>
              <Label>人物/剧情关联</Label>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                <Markdown text={fields.relation} className="text-sm leading-6 text-zinc-300" />
              </div>
            </section>
          ) : (
            <div className="text-xs text-zinc-600">暂无关联</div>
          )}
        </>
      ) : (
        <>
          <Label>
            标题
            <Input value={fields.title} onChange={(e) => patch({ title: e.target.value })} />
          </Label>
          <Label>
            标签（逗号或、分隔）
            <Input value={fields.tags} onChange={(e) => patch({ tags: e.target.value })} />
          </Label>
          <Label>
            人物/剧情关联（与主要人物或剧情线的关系，可含 [[条目名]] 链接）
            <Input
              value={fields.relation}
              onChange={(e) => patch({ relation: e.target.value })}
              placeholder="如：[[丹塔]] 是主角曾依附的势力"
            />
          </Label>
          <Label>
            条目分节
            {!secsLoaded ? (
              <div className="mt-1.5 rounded-md border border-zinc-800 p-3 text-xs text-zinc-600">
                分节加载中…
              </div>
            ) : (
              <div className="mt-1.5 space-y-2">
                {sections.map((s, i) => (
                  <div key={s.id ?? `new-${i}`} className="rounded-md border border-zinc-800 p-2">
                    <div className="mb-1 flex items-center gap-2">
                      <Input
                        className="h-7 flex-1 text-xs"
                        value={s.title}
                        placeholder="字段名，如 概述"
                        onChange={(e) =>
                          setSections((arr) =>
                            arr.map((x, j) => (j === i ? { ...x, title: e.target.value } : x))
                          )
                        }
                      />
                      <Button
                        variant="ghost"
                        className="px-1.5 py-0.5 text-xs text-red-400/90"
                        onClick={() => setSections((arr) => arr.filter((_, j) => j !== i))}
                      >
                        删
                      </Button>
                    </div>
                    <Textarea
                      rows={Math.min(12, Math.max(3, Math.ceil(s.content.length / 30)))}
                      value={s.content}
                      placeholder="该节的正文（markdown，要点式）"
                      onChange={(e) =>
                        setSections((arr) =>
                          arr.map((x, j) => (j === i ? { ...x, content: e.target.value } : x))
                        )
                      }
                    />
                  </div>
                ))}
                <Button
                  variant="ghost"
                  className="w-full px-2 py-1 text-xs"
                  onClick={() => setSections((arr) => [...arr, { title: '', content: '' }])}
                >
                  + 添加分节
                </Button>
              </div>
            )}
          </Label>
        </>
      )}
    </DetailShell>
  )
}
