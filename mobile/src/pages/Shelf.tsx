import { useQuery } from '@tanstack/react-query'
import { Button, Empty } from '@mobile/components/ui'
import { fmtRelative, fmtWords } from '@mobile/lib/format'
import { putBriefs } from '@mobile/lib/readerCache'
import { withSnapshot } from '@mobile/lib/querySnapshot'
import type { Project } from '@shared/types'

function hueFromId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 360
}

function Cover({ project, onOpen }: { project: Project; onOpen: (id: string) => void }) {
  const { data: briefs } = useQuery({
    queryKey: ['novel', 'chapterBriefs', project.id],
    queryFn: withSnapshot(['novel', 'chapterBriefs', project.id], async () => {
      // 同 queryKey 以首个挂载的 observer 的 queryFn 为准（书架总是先进），阅读侧目录快照落库必须写在这里
      const fresh = await window.api.novel.chapterBriefs(project.id)
      void putBriefs({ projectId: project.id, title: project.title, briefs: fresh, cachedAt: Date.now() })
      return fresh
    }),
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

export default function Shelf({
  onOpen,
  onCreate
}: {
  onOpen: (id: string) => void
  onCreate: () => void
}) {
  // 与 App.tsx 同 key 共用内存缓存；成功双写快照，失败回退快照（断网书架仍可用）
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['novel', 'projects'],
    queryFn: withSnapshot(['novel', 'projects'], () => window.api.novel.projects())
  })

  if (isLoading) return <Empty text="加载中…" />
  if (projects.length === 0)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-4xl">📚</div>
        <p className="text-sm text-zinc-500">书架还是空的，创建你的第一本小说吧</p>
        <Button onClick={onCreate}>＋ 新建项目</Button>
      </div>
    )

  return (
    <div className="relative">
      <div className="grid grid-cols-2 gap-3 p-3">
        {projects.map((p) => (
          <Cover key={p.id} project={p} onOpen={onOpen} />
        ))}
      </div>
      <button
        type="button"
        aria-label="新建项目"
        onClick={onCreate}
        className="fixed bottom-20 right-4 z-20 flex h-12 w-12 cursor-pointer items-center justify-center rounded-full bg-amber-600 text-2xl leading-none text-white shadow-lg shadow-black/40 transition-transform active:scale-95"
      >
        ＋
      </button>
    </div>
  )
}
