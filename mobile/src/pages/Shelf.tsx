import { useQuery } from '@tanstack/react-query'
import { Empty } from '@mobile/components/ui'
import { fmtRelative, fmtWords } from '@mobile/lib/format'
import type { Project } from '@shared/types'

function hueFromId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 360
}

function Cover({ project, onOpen }: { project: Project; onOpen: (id: string) => void }) {
  const { data: briefs } = useQuery({
    queryKey: ['novel', 'chapterBriefs', project.id],
    queryFn: () => window.api.novel.chapterBriefs(project.id),
    staleTime: 60_000
  })
  const words = (briefs ?? []).reduce((s, b) => s + b.wordCount, 0)
  const hue = hueFromId(project.id)

  return (
    <div
      role="button"
      tabIndex={0}
      className="cursor-pointer active:opacity-80"
      onClick={() => onOpen(project.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(project.id)
      }}
    >
      <div
        className="relative flex aspect-[3/4] flex-col justify-end overflow-hidden rounded-lg border border-white/10 shadow-lg shadow-black/40"
        style={{
          background: `linear-gradient(160deg, hsl(${hue} 45% 34%) 0%, hsl(${(hue + 40) % 360} 55% 16%) 100%)`
        }}
      >
        <div className="absolute inset-y-0 left-0 w-1.5 bg-black/30" />
        <div className="absolute inset-x-0 top-0 h-px bg-white/25" />
        <div className="flex flex-1 items-center justify-center px-3">
          <span
            className="line-clamp-4 text-center text-lg font-semibold leading-snug text-white/95"
            style={{ textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}
          >
            {project.title}
          </span>
        </div>
        <div className="relative px-2.5 pb-2 text-[10px] text-white/60">
          {project.genre || '未分类'}
        </div>
      </div>
      <div className="mt-1.5 px-0.5 text-[11px] leading-4 text-zinc-500">
        <div>
          {words > 0 ? fmtWords(words) : '未动笔'} · {fmtRelative(project.updatedAt)}
        </div>
      </div>
    </div>
  )
}

export default function Shelf({ onOpen }: { onOpen: (id: string) => void }) {
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['novel', 'projects'],
    queryFn: () => window.api.novel.projects()
  })

  if (isLoading) return <Empty text="加载中…" />
  if (projects.length === 0) return <Empty text="电脑端还没有项目，请先在桌面端创建" />

  return (
    <div className="grid grid-cols-2 gap-3 p-3">
      {projects.map((p) => (
        <Cover key={p.id} project={p} onOpen={onOpen} />
      ))}
    </div>
  )
}
