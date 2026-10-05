import { Empty, Input, Label, Textarea } from '@mobile/components/ui'
import { mobileWizardUi } from '@mobile/lib/wizardUi'
import { DetailShell, EditBar, Row } from '@mobile/pages/subs/parts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { startGen, useWbGenTasks, useWbLiveEntries } from '@wizard/wbGenStore'
import { NumberField } from '@wizard/widgets'
import { loadProjectPlan, saveProjectPlan } from '@wizard/wizardPlan'
import { withSnapshot } from '@mobile/lib/querySnapshot'
import type { WorldbuildEntry } from '@shared/types'

/** 世界观子页：方向/类型/条目数 → 后台流式生成入库（wbGenStore）+ 分类分组列表 + 条目编辑 */
export default function WorldSub({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { Badge: B, Button: Btn } = mobileWizardUi
  const { data: list = [], isLoading } = useQuery({
    queryKey: ['novel', 'worldbuild', projectId],
    queryFn: withSnapshot(['novel', 'worldbuild', projectId], () =>
      window.api.novel.worldbuild(projectId)
    )
  })
  const [editId, setEditId] = useState<string | null>(null)
  const editing = list.find((w) => w.id === editId) ?? null

  // —— 生成区（预填「基本设定」方案里的方向/类型/条目数）——
  const [brief, setBrief] = useState('')
  const [cats, setCats] = useState<string[]>([])
  const [count, setCount] = useState(8)
  const [typeOptions, setTypeOptions] = useState<string[]>([])
  const [started, setStarted] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const beforeRef = useRef<number | null>(null)
  const wbTasks = useWbGenTasks(projectId)
  const wbLive = useWbLiveEntries(projectId)
  const running = wbTasks.length > 0
  const task = wbTasks[0] ?? null

  useEffect(() => {
    let alive = true
    void Promise.all([loadProjectPlan(projectId), window.api.novel.worldbuildTypes(projectId)])
      .then(([plan, types]) => {
        if (!alive) return
        if (plan) {
          setBrief(plan.wbBrief)
          setCats(plan.wbCats)
          setCount(plan.wbCount)
        }
        setTypeOptions(types)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId])

  // 生成结束后统计本次入库条数
  useEffect(() => {
    if (!started || running) return
    void window.api.novel
      .worldbuild(projectId)
      .then((l) => {
        const before = beforeRef.current
        if (before === null) return
        const n = l.length - before
        setResult(n > 0 ? `本次生成入库 ${n} 条世界观条目` : '本次未解析出有效条目，可调整需求后重试')
      })
      .catch(() => {})
  }, [started, running, projectId])

  const toggleCat = (c: string): void =>
    setCats((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))

  const start = (): void => {
    if (!brief.trim() || running) return
    setResult(null)
    void window.api.novel
      .worldbuild(projectId)
      .then((l) => {
        beforeRef.current = l.length
      })
      .catch(() => {})
    // 参数记忆：写回 wizard_plan，下次进入预填
    void saveProjectPlan(projectId, { wbBrief: brief.trim(), wbCats: cats, wbCount: count })
    startGen({
      projectId,
      categories: cats,
      title: '',
      brief: brief.trim(),
      count: count >= 1 ? Math.floor(count) : undefined
    })
    setStarted(true)
  }

  if (editing)
    return (
      <WorldEditor
        key={editing.id}
        projectId={projectId}
        entry={editing}
        onBack={() => setEditId(null)}
        onSaved={() => void qc.invalidateQueries({ queryKey: ['novel', 'worldbuild', projectId] })}
      />
    )

  const groups = [...new Set(list.map((w) => w.category))]

  return (
    <div className="h-full overflow-y-auto overscroll-contain p-3">
      <div className="space-y-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="flex items-center gap-2">
          <Label>世界观方向（AI 生成条目的需求描述）</Label>
          {list.length > 0 && <B tone="green">已有 {list.length} 条</B>}
        </div>
        <Textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={3}
          style={{ resize: 'vertical' }}
          disabled={running}
          placeholder="例：低魔武侠世界，内力源于血脉，朝廷与江湖门派相互制衡…"
        />
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="shrink-0 text-zinc-500">类型</span>
          {typeOptions.map((t) => (
            <button
              type="button"
              key={t}
              disabled={running}
              onClick={() => toggleCat(t)}
              className={`cursor-pointer rounded-full px-2.5 py-0.5 transition-colors disabled:cursor-default ${
                cats.includes(t) ? 'bg-amber-600/20 text-amber-300' : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="shrink-0 text-zinc-500">条目数</span>
          <NumberField
            input={Input}
            value={count}
            min={1}
            max={12}
            onChange={setCount}
            disabled={running}
            className="w-20"
          />
        </div>
        {running && task && (
          <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-400">
            <div className="text-amber-300">
              生成中（{task.status === 'retrieving' ? '检索相关条目' : '生成'}）
              {task.committedCount > 0 && ` · 已入库 ${task.committedCount} 条`}
            </div>
            {wbLive.length > 0 && (
              <div className="mt-1 truncate text-zinc-500">
                {wbLive
                  .slice(-3)
                  .map((s) => s.title)
                  .join(' / ')}
              </div>
            )}
          </div>
        )}
        {result && !running && <div className="text-xs text-emerald-400">{result}</div>}
        <Btn onClick={start} disabled={!brief.trim() || running}>
          {running ? '生成中…' : started ? '再次生成' : '开始生成世界观'}
        </Btn>
      </div>

      <div className="mt-4 space-y-4">
        {isLoading ? (
          <Empty text="加载中…" />
        ) : list.length === 0 ? (
          <Empty text="暂无世界观条目" />
        ) : (
          groups.map((cat) => (
            <div key={cat}>
              <div className="mb-1.5 px-1 text-xs font-medium text-zinc-500">{cat}</div>
              <div className="space-y-1.5">
                {list
                  .filter((w) => w.category === cat)
                  .map((w) => (
                    <Row key={w.id} title={w.title} sub={w.tags || undefined} onClick={() => setEditId(w.id)} />
                  ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

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
  const [title, setTitle] = useState(entry.title)
  const [tags, setTags] = useState(entry.tags)
  const [content, setContent] = useState(entry.content)
  const [relation, setRelation] = useState(entry.relation)
  const [saving, setSaving] = useState(false)
  const dirty =
    title !== entry.title ||
    tags !== entry.tags ||
    content !== entry.content ||
    relation !== entry.relation

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.novel.worldbuildSave({
        id: entry.id,
        projectId,
        category: entry.category,
        title,
        tags,
        content,
        relation
      })
      onSaved()
      onBack()
    } finally {
      setSaving(false)
    }
  }

  return (
    <DetailShell
      title={entry.title}
      onBack={onBack}
      dirty={dirty}
      bar={<EditBar dirty={dirty} saving={saving} onSave={() => void save()} />}
    >
      <Label>
        标题
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Label>
      <Label>
        标签
        <Input value={tags} onChange={(e) => setTags(e.target.value)} />
      </Label>
      <Label>
        人物/剧情关联（与主要人物或剧情线的关系，可含 [[条目名]] 链接）
        <Input
          value={relation}
          onChange={(e) => setRelation(e.target.value)}
          placeholder="如：[[丹塔]] 是主角曾依附的势力"
        />
      </Label>
      <Label>
        内容
        <Textarea rows={14} value={content} onChange={(e) => setContent(e.target.value)} />
      </Label>
    </DetailShell>
  )
}
