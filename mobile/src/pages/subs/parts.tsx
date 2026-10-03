import { useBackHandler } from '@mobile/lib/backHandler'
import { Button, Spinner } from '@mobile/components/ui'
import { useCallback } from 'react'
import type { ReactNode } from 'react'

/** 子页共用小件：列表行 / 保存条 / 全屏编辑壳（设定类子页复用） */

export function Row({
  title,
  sub,
  right,
  onClick
}: {
  title: string
  sub?: string
  right?: ReactNode
  onClick: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className="flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 active:bg-zinc-900"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick()
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-zinc-200">{title}</div>
        {sub && <div className="mt-0.5 truncate text-[11px] text-zinc-600">{sub}</div>}
      </div>
      {right}
    </div>
  )
}

export function EditBar({
  dirty,
  saving,
  onSave
}: {
  dirty: boolean
  saving: boolean
  onSave: () => void
}) {
  return (
    <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <span className="text-xs text-zinc-600">{dirty ? '有未保存修改' : '已保存'}</span>
      <Button className="ml-auto px-3.5 py-1.5 text-xs" disabled={!dirty || saving} onClick={onSave}>
        {saving ? <Spinner className="h-3.5 w-3.5" /> : '保存'}
      </Button>
    </div>
  )
}

export function DetailShell({
  title,
  onBack,
  dirty,
  children,
  bar
}: {
  title: string
  onBack: () => void
  dirty?: boolean
  children: ReactNode
  bar?: ReactNode
}) {
  // 编辑器返回键与 UI 返回按钮同语义：有未保存修改先确认
  const leave = useCallback((): void => {
    if (dirty && !window.confirm('有未保存的修改，确定离开？')) return
    onBack()
  }, [dirty, onBack])
  useBackHandler(leave)
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/95 px-2 py-2">
        <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={leave}>
          ← 返回
        </Button>
        <div className="min-w-0 flex-1 truncate text-center text-sm font-medium text-zinc-200">
          {title}
        </div>
        <div className="w-14" />
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">{children}</div>
      {bar}
    </div>
  )
}
