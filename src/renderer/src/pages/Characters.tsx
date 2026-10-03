import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { CharacterGenPanel } from '../../../wizard/CharacterGenPanel'
import { AiTextarea } from '../components/AiTextarea'
import { Badge, Button, Card, Input, Label } from '../components/ui'
import { desktopWizardUi } from '../lib/desktopWizardUi'
import type { Navigate } from '../lib/nav'
import { qk, queries } from '../lib/queries'

interface EditState {
  id: string
  name: string
  role: string
  tags: string
  card: string
  state: string
}

export default function Characters({
  projectId,
  onNavigate
}: {
  projectId: string
  onNavigate: Navigate
}) {
  const queryClient = useQueryClient()
  const { data: list = [] } = useQuery(queries.characters(projectId))
  const [edit, setEdit] = useState<EditState | null>(null)
  const [genOpen, setGenOpen] = useState(false)

  const load = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.characters(projectId) })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId 仅作重置信号
  useEffect(() => {
    setEdit(null)
  }, [projectId])

  if (!projectId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-600">
        请先选择一个项目
        <Button onClick={() => onNavigate('projects')}>去选择项目</Button>
      </div>
    )
  }

  const pick = (c: (typeof list)[number]): void => {
    setEdit({ id: c.id, name: c.name, role: c.role, tags: c.tags, card: c.card, state: c.state })
  }

  const save = (): void => {
    if (!edit?.name.trim()) return
    void window.api.novel
      .characterSave({
        id: edit.id,
        projectId,
        name: edit.name.trim(),
        role: edit.role,
        tags: edit.tags,
        card: edit.card,
        state: edit.state
      })
      .then(() => {
        load()
      })
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:flex-row md:p-4">
      <Card className="flex max-h-44 shrink-0 flex-col md:max-h-none md:w-64">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2.5">
          <span className="text-sm font-medium text-zinc-200">人物（{list.length}）</span>
          <Button className="px-2 py-1 text-xs" onClick={() => setGenOpen(true)}>
            AI 生成
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {list.length === 0 && (
            <div className="space-y-2.5 p-4 text-center">
              <div className="text-xs text-zinc-600">暂无人物</div>
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={() => setGenOpen(true)}
              >
                用 AI 生成班底
              </Button>
            </div>
          )}
          {list.map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => pick(c)}
              className={`mb-1 w-full cursor-pointer rounded-md px-3 py-2 text-left transition-colors ${
                edit?.id === c.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-sm text-zinc-200">{c.name}</span>
                {c.role && <Badge>{c.role}</Badge>}
              </div>
              {c.tags && <div className="mt-0.5 truncate text-xs text-zinc-500">{c.tags}</div>}
            </button>
          ))}
        </div>
      </Card>

      <Card className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-medium text-zinc-200">AI 生成班底</div>
          <Button variant="ghost" onClick={() => setGenOpen((v) => !v)}>
            {genOpen ? '收起' : '展开'}
          </Button>
        </div>
        {genOpen && (
          <div className="mb-4 rounded-md border border-zinc-800 bg-zinc-900/50 p-3">
            <CharacterGenPanel ui={desktopWizardUi} projectId={projectId} onChanged={load} />
          </div>
        )}

        <div className="mb-3 border-t border-zinc-800 pt-3">
          <div className="text-sm font-medium text-zinc-200">
            {edit ? `编辑人物：${edit.name || '未命名'}` : '人物详情'}
          </div>
        </div>

        {!edit ? (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">
            从左侧选择人物查看与编辑；还没有人物时先用上方 AI 生成班底
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <Label>姓名 *</Label>
                <Input
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                  placeholder="例：韩立"
                />
              </div>
              <div>
                <Label>定位</Label>
                <Input
                  value={edit.role}
                  onChange={(e) => setEdit({ ...edit, role: e.target.value })}
                  placeholder="主角/反派/师尊…"
                />
              </div>
              <div>
                <Label>标签</Label>
                <Input
                  value={edit.tags}
                  onChange={(e) => setEdit({ ...edit, tags: e.target.value })}
                  placeholder="谨慎,苟道"
                />
              </div>
            </div>
            <div className="mt-3 flex-1">
              <Label>人物卡（markdown，M4 写作时自动注入相关人物；选中文字可用 AI 改写）</Label>
              <AiTextarea
                className="h-full min-h-72"
                value={edit.card}
                onChange={(v) => setEdit({ ...edit, card: v })}
                placeholder={'- 基本信息：…\n- 性格核心：…\n- 欲望与恐惧：…\n- 口癖与语言习惯：…'}
                context={`这是人物「${edit.name || '未命名'}」（定位：${edit.role || '未填'}）的人物卡全文：\n${edit.card}`}
              />
            </div>
            <div className="mt-3">
              <Label>
                动态状态（定稿章节时由摘要自动同步：物品/能力/身心状态/关系/最近事件；写作时随人物卡注入）
              </Label>
              <textarea
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-xs leading-5 text-zinc-200 outline-none focus:border-zinc-600"
                rows={Math.min(12, Math.max(3, Math.ceil(edit.state.length / 60)))}
                value={edit.state}
                onChange={(e) => setEdit({ ...edit, state: e.target.value })}
                placeholder={
                  '物品：寒铁长剑（断裂）\n身心状态：左臂旧伤未愈，对宗门起疑\n关系：与云岚由盟转敌\n最近事件：第12章 黑袍人交出半张地图'
                }
              />
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="danger"
                onClick={() => {
                  if (!window.confirm(`删除人物「${edit.name}」？`)) return
                  void window.api.novel.characterDelete(edit.id).then(() => {
                    setEdit(null)
                    load()
                  })
                }}
              >
                删除
              </Button>
              <Button variant="ghost" onClick={() => setEdit(null)}>
                关闭
              </Button>
              <Button onClick={save} disabled={!edit.name.trim()}>
                保存
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
