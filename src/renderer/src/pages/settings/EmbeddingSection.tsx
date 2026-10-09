import type { EmbeddingStatus } from '@shared/types'
import { useEffect, useState } from 'react'
import { Badge, Button, Card } from '../../components/ui'
import { SECTIONS, SectionHead } from './nav'

export function EmbeddingSection(): React.ReactElement {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const load = (): void => {
    void window.api.embedding.status().then(setStatus)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载执行一次；load 引用不稳定，故意不进 deps
  useEffect(() => {
    load()
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载执行一次；load 引用不稳定，故意不进 deps
  useEffect(() => {
    if (!status?.downloading) return
    const t = setInterval(load, 1500)
    return () => clearInterval(t)
  }, [status?.downloading])

  const toggle = async (enabled: boolean): Promise<void> => {
    await window.api.embedding.setEnabled(enabled)
    load()
  }

  const rebuild = async (): Promise<void> => {
    setBusy(true)
    setNotice('重建索引中（首次会先下载模型，约 25MB）…')
    try {
      const r = await window.api.embedding.rebuild()
      setNotice(`已重建 ${r.count} 条语义索引`)
    } catch (err) {
      setNotice(`重建失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
      load()
    }
  }

  return (
    <div className="space-y-4">
      <SectionHead meta={SECTIONS[3]} />
      {!status ? (
        <Card className="space-y-2 p-5 text-sm text-zinc-500">语义检索加载中…</Card>
      ) : (
        <Card className="space-y-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={status.enabled}
                disabled={status.downloading}
                onChange={(e) => void toggle(e.target.checked)}
                className="h-3.5 w-3.5 cursor-pointer accent-amber-600"
              />
              启用
            </label>
          </div>
          <div className="text-xs leading-5 text-zinc-500">
            写作上下文与智能体检索用本地嵌入模型（{status.model}）按语义召回相关设定/人物/章节，
            与知识图谱链接互补；完全本地运行，不消耗云端 token。首次使用需下载约 25MB 模型（默认走
            hf-mirror，可用环境变量 HF_ENDPOINT 覆盖）。
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <Badge
              tone={status.enabled && !status.reason ? 'green' : status.enabled ? 'red' : 'default'}
            >
              {status.enabled ? (status.reason ? '模型不可用（已降级）' : '就绪') : '已关闭'}
            </Badge>
            <span className="text-zinc-500">已索引 {status.count} 条</span>
            {status.downloading && (
              <span className="text-amber-400">模型下载中 {Math.round(status.progress)}%</span>
            )}
            <Button
              variant="ghost"
              className="ml-auto px-2 py-1 text-xs"
              onClick={() => void rebuild()}
              disabled={busy || !status.enabled}
            >
              {busy ? '重建中…' : '重建索引'}
            </Button>
          </div>
          {status.reason && <div className="text-xs text-red-400">{status.reason}</div>}
          {notice && <div className="text-xs text-zinc-400">{notice}</div>}
        </Card>
      )}
    </div>
  )
}
