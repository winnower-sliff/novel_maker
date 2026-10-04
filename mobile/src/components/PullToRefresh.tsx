import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'

const THRESHOLD = 64
const MAX_PULL = 120
/** 松手后的刷新条高度与回弹延迟（让「刷新中…」可感知） */
const SPINNER_H = 44

/**
 * 下拉刷新容器：替代各页「h-full overflow-y-auto」外壳。
 * scrollTop=0 时向下拖动 → 顶部出现 spinner，超过阈值松手 → 全量失效 ['novel'] 重拉。
 * 章节编辑态等不适合自动重拉的页面不要接入。
 */
export function PullToRefresh({
  children,
  className = ''
}: {
  children: React.ReactNode
  className?: string
}) {
  const qc = useQueryClient()
  const ref = useRef<HTMLDivElement>(null)
  const startY = useRef<number | null>(null)
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const onTouchStart = (e: React.TouchEvent): void => {
    if (refreshing) return
    const el = ref.current
    if (!el || el.scrollTop > 0) return
    startY.current = e.touches[0].clientY
  }

  const onTouchMove = (e: React.TouchEvent): void => {
    if (startY.current === null || refreshing) return
    const el = ref.current
    if (!el || el.scrollTop > 0) return
    const d = e.touches[0].clientY - startY.current
    if (d <= 0) return
    // 阻尼跟手；配合 overscroll-contain 压掉 WebView 自带回弹
    setPull(Math.min((d * 0.45) | 0, MAX_PULL))
  }

  const onTouchEnd = (): void => {
    const dist = pull
    startY.current = null
    if (dist >= THRESHOLD) {
      setRefreshing(true)
      setPull(SPINNER_H)
      void qc
        .invalidateQueries({ queryKey: ['novel'] })
        .catch(() => {})
        .finally(() => {
          // 短暂停留让 spinner 可见，再回弹收起
          setTimeout(() => {
            setRefreshing(false)
            setPull(0)
          }, 400)
        })
    } else {
      setPull(0)
    }
  }

  const show = pull > 0
  const armed = pull >= THRESHOLD
  return (
    <div
      ref={ref}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      className={`relative h-full overflow-y-auto overscroll-contain ${className}`}
    >
      {show && (
        <div
          className={`absolute inset-x-0 top-0 flex items-center justify-center gap-2 text-xs transition-[height] ${
            refreshing ? 'duration-300' : ''
          }`}
          style={{ height: pull }}
        >
          <span
            className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-amber-500 ${
              armed || refreshing ? '' : 'opacity-40'
            }`}
          />
          <span className="text-zinc-500">
            {refreshing ? '刷新中…' : armed ? '松开刷新' : '下拉刷新'}
          </span>
        </div>
      )}
      <div
        className={refreshing ? 'transition-transform duration-300' : ''}
        style={{ transform: `translateY(${pull}px)` }}
      >
        {children}
      </div>
    </div>
  )
}
