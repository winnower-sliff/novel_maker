import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fmtRelative, fmtWords } from '@mobile/lib/format'
import { Badge, Card, Empty, Spinner } from '@mobile/components/ui'

export default function Home({ currentProjectId }: { currentProjectId: string }) {
  const qc = useQueryClient()
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['novel', 'projects'],
    queryFn: () => window.api.novel.projects()
  })
  const switchProject = useMutation({
    mutationFn: (id: string) => window.api.settings.save({ currentProjectId: id }),
    onSuccess: () => {
      void qc.invalidateQueries()
    }
  })

  if (isLoading) return <Empty text="加载中…" />
  if (projects.length === 0) return <Empty text="电脑端还没有项目，请先在桌面端创建" />

  return (
    <div className="space-y-2.5 p-3">
      {projects.map((p) => {
        const active = p.id === currentProjectId
        return (
          <Card
            key={p.id}
            className={`p-4 ${active ? 'border-amber-600/60' : ''} cursor-pointer active:bg-zinc-900`}
          >
            <div
              role="button"
              tabIndex={0}
              className="flex items-center gap-2"
              onClick={() => {
                if (!active) switchProject.mutate(p.id)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !active) switchProject.mutate(p.id)
              }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-base font-medium text-zinc-100">{p.title}</span>
                  {active && <Badge className="bg-amber-600/20 text-amber-400">当前</Badge>}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                  {p.genre && <span>{p.genre}</span>}
                  {p.targetWords > 0 && <span>目标 {fmtWords(p.targetWords)}</span>}
                  <span className="ml-auto">{fmtRelative(p.updatedAt)}</span>
                </div>
              </div>
              {switchProject.isPending && switchProject.variables === p.id && <Spinner />}
            </div>
          </Card>
        )
      })}
      <p className="px-1 pt-1 text-center text-[11px] text-zinc-600">
        切换项目后，「写作 / 智能体 / 设定」页将显示所选项目的内容
      </p>
    </div>
  )
}
