// canonSync 世界观预览确认弹窗：两端 App 根部挂载（桌面 desktopWizardUi / 手机 mobileWizardUi），
// 人物部分主进程已自动落库，这里只负责世界观新增/修订的勾选确认。
import {
  confirmCanon,
  dismissCanon,
  toggleCanonNew,
  toggleCanonUpdate,
  useCanonStore
} from './canonStore'
import { OverlayCard } from './OverlayCard'
import type { WizardUi } from './uiTypes'

function EntryBody({ text }: { text: string }) {
  return (
    <p className="mt-1 line-clamp-3 text-xs leading-relaxed whitespace-pre-line text-zinc-400">
      {text}
    </p>
  )
}

export function CanonPreviewPanel({ ui }: { ui: WizardUi }) {
  const pending = useCanonStore((s) => s.pending)
  const { Badge, Button } = ui
  if (!pending) return null
  return (
    <OverlayCard
      open
      onClose={dismissCanon}
      fullscreenOnMobile
      title={
        <span>
          设定同步 · 第 {pending.volume} 卷
          <span className="ml-2 text-xs font-normal text-zinc-500">大纲导入后自动比对</span>
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={dismissCanon} disabled={pending.saving}>
            暂不导入
          </Button>
          <Button onClick={confirmCanon} disabled={pending.saving}>
            {pending.saving ? '导入中…' : '导入勾选条目'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-xs leading-relaxed text-zinc-500">
          AI 对照新大纲检查了世界观设定库：勾选要导入的条目。新人物与人物修订已自动入库，无需操作。
        </p>
        {pending.error && <p className="text-xs text-red-400">{pending.error}</p>}

        {pending.worldNew.length > 0 && (
          <section>
            <h4 className="mb-2 text-xs font-semibold text-zinc-300">
              新增条目（{pending.worldNew.length}）
            </h4>
            <div className="space-y-2">
              {pending.worldNew.map((e, i) => (
                <label
                  key={`${e.category}:${e.title}`}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border border-zinc-800 bg-zinc-950/60 p-2.5"
                >
                  <input
                    type="checkbox"
                    checked={pending.newChecked[i] ?? false}
                    onChange={() => toggleCanonNew(i)}
                    className="mt-0.5 accent-amber-600"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={e.isNewType ? 'amber' : 'default'}>{e.category}</Badge>
                      <span className="text-xs font-medium text-zinc-100">{e.title}</span>
                    </span>
                    <EntryBody text={e.content} />
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}

        {pending.worldUpdates.length > 0 && (
          <section>
            <h4 className="mb-2 text-xs font-semibold text-zinc-300">
              修订建议（{pending.worldUpdates.length}，默认不勾选——确认后按修订版覆盖原文）
            </h4>
            <div className="space-y-2">
              {pending.worldUpdates.map((u, i) => (
                <label
                  key={u.id}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border border-zinc-800 bg-zinc-950/60 p-2.5"
                >
                  <input
                    type="checkbox"
                    checked={pending.updateChecked[i] ?? false}
                    onChange={() => toggleCanonUpdate(i)}
                    className="mt-0.5 accent-amber-600"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="amber">{u.category}</Badge>
                      <span className="text-xs font-medium text-zinc-100">{u.title}</span>
                    </span>
                    <EntryBody text={u.content} />
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}
      </div>
    </OverlayCard>
  )
}
