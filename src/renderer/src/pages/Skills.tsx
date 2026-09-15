import { useEffect, useState } from 'react'
import type { SkillFile, SkillMeta } from '@shared/types'
import { Badge, Button, Card, Textarea } from '../components/ui'

export default function Skills() {
  const [list, setList] = useState<SkillMeta[]>([])
  const [current, setCurrent] = useState<SkillFile | null>(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState(0)

  const load = (selectFilename?: string): void => {
    void window.api.skills.list().then((l) => {
      setList(l)
      const target = selectFilename ? l.find((s) => s.filename === selectFilename) : l[0]
      if (target) void openSkill(target.filename)
      else {
        setCurrent(null)
        setDraft('')
      }
    })
  }

  const openSkill = (filename: string): void => {
    void window.api.skills.get(filename).then((f) => {
      setCurrent(f)
      setDraft(f?.raw ?? '')
      setDirty(false)
    })
  }

  useEffect(() => {
    load()
  }, [])

  const save = (): void => {
    if (!current) return
    void window.api.skills.save(current.filename, draft).then(() => {
      setDirty(false)
      setSavedAt(Date.now())
      load(current.filename)
    })
  }

  const create = (): void => {
    const name = window.prompt('技能名（英文，作文件名）')
    if (!name) return
    const safe = name.trim().replace(/[\\/:*?"<>|]/g, '-')
    const template = `---\nname: ${safe}\ndescription: 描述与触发词\n---\n\n# 指令内容`
    void window.api.skills.save(`${safe}.md`, template).then(() => load(`${safe}.md`))
  }

  const remove = (): void => {
    if (!current) return
    if (!window.confirm(`删除技能「${current.name}」？`)) return
    void window.api.skills.delete(current.filename).then(() => load())
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:flex-row md:p-4">
      <Card className="flex max-h-40 shrink-0 flex-col md:max-h-none md:w-72">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2.5">
          <span className="text-sm font-medium text-zinc-200">技能（{list.length}）</span>
          <Button className="px-2 py-1 text-xs" onClick={create}>
            + 新建
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {list.map((s) => (
            <button
              key={s.filename}
              onClick={() => openSkill(s.filename)}
              className={`mb-1 w-full cursor-pointer rounded-md px-3 py-2 text-left transition-colors ${
                current?.filename === s.filename ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
              }`}
            >
              <div className="truncate font-mono text-xs text-amber-400/90">{s.name}</div>
              <div className="mt-0.5 line-clamp-2 text-xs leading-4 text-zinc-500">{s.description}</div>
            </button>
          ))}
        </div>
        <div className="border-t border-zinc-800 px-3 py-2 text-[10px] leading-4 text-zinc-600">
          技能文件为 markdown（frontmatter: name / description），存于用户数据目录 skills/。M4
          起可按用途挂载到生成流程。
        </div>
      </Card>

      <Card className="flex min-w-0 flex-1 flex-col p-4">
        {current ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-sm text-zinc-200">{current.name}</span>
              {dirty && <Badge tone="amber">未保存</Badge>}
              {savedAt > 0 && !dirty && <Badge tone="green">已保存</Badge>}
              <div className="ml-auto flex gap-2">
                <Button variant="danger" onClick={remove}>
                  删除
                </Button>
                <Button onClick={save} disabled={!dirty}>
                  保存
                </Button>
              </div>
            </div>
            <Textarea
              className="h-[calc(100%-2.5rem)] font-mono text-xs leading-5"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setDirty(true)
              }}
              spellCheck={false}
            />
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-zinc-600">
            选择左侧技能查看/编辑
          </div>
        )}
      </Card>
    </div>
  )
}
