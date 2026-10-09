import type { ServerConfigPatch, ServerStatus } from '@shared/types'
import { useEffect, useState } from 'react'
import { Badge, Button, Card, Input, Label } from '../../components/ui'
import { SECTIONS, SectionHead } from './nav'

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 非安全上下文时回退 */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
    return true
  } catch {
    return false
  }
}

export function ServerSection() {
  const isWeb = !!window.__NM_WEB__
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [port, setPort] = useState('3910')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    void window.api.server.status().then((s) => {
      setStatus(s)
      setEnabled(s.enabled)
      setPort(String(s.port))
    })
  }, [])

  const apply = (patch: ServerConfigPatch): void => {
    setBusy(true)
    setMessage('')
    void window.api.server
      .config(patch)
      .then((s) => {
        setStatus(s)
        setEnabled(s.enabled)
        setPort(String(s.port))
        setPassword('')
        setMessage(s.running ? `已生效，监听端口 ${s.port}` : '已保存（服务器未运行）')
      })
      .catch((err: unknown) => setMessage((err as Error).message))
      .finally(() => setBusy(false))
  }

  const save = (): void => {
    const parsed = parseInt(port, 10)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
      setMessage('端口必须是 1-65535 之间的整数')
      return
    }
    const patch: ServerConfigPatch = { enabled, port: parsed }
    if (password.trim() !== '') patch.password = password.trim()
    apply(patch)
  }

  const clearPassword = (): void => {
    if (!window.confirm('清除访问密码后，局域网设备将无法访问（仅本机可用）。确定清除？')) return
    apply({ password: '' })
  }

  const toggle = (next: boolean): void => {
    setEnabled(next)
    apply({ enabled: next })
  }

  return (
    <div className="space-y-4">
      <SectionHead
        meta={SECTIONS[4]}
        right={
          status ? (
            <Badge tone={status.running ? 'green' : 'default'}>
              {status.running ? `运行中 · ${status.clients} 连接` : '已停止'}
            </Badge>
          ) : undefined
        }
      />
      <Card className="space-y-4 p-5">
        {isWeb ? (
          <div className="text-xs text-zinc-500">
            当前正通过浏览器访问，服务器配置请在桌面端修改。
          </div>
        ) : (
          <>
            <label className="flex cursor-pointer items-center gap-2.5 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={enabled}
                disabled={busy}
                onChange={(e) => toggle(e.target.checked)}
                className="h-4 w-4 cursor-pointer accent-amber-600 disabled:cursor-not-allowed"
              />
              随应用启动服务器（关闭后手机无法访问）
            </label>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label>监听端口</Label>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  disabled={busy}
                  onChange={(e) => setPort(e.target.value)}
                />
              </div>
              <div>
                <Label>{status?.hasPassword ? '修改访问密码' : '设置访问密码'}</Label>
                <Input
                  type="password"
                  value={password}
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="留空则不修改"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={save} disabled={busy}>
                {busy ? '应用中…' : '保存并重启'}
              </Button>
              {status?.hasPassword && (
                <Button variant="ghost" onClick={clearPassword} disabled={busy}>
                  清除密码
                </Button>
              )}
            </div>
          </>
        )}

        {status?.running && status.url && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-xs text-zinc-500">
              {isWeb ? '当前访问地址：' : '手机与电脑连接同一 Wi-Fi 后，用浏览器打开：'}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-sm text-amber-400">
                {status.url}
              </code>
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={() => {
                  if (!status.url) return
                  void copyText(status.url).then((ok) =>
                    setMessage(ok ? '已复制访问地址' : '复制失败，请手动选择复制')
                  )
                }}
              >
                复制
              </Button>
            </div>
          </div>
        )}

        {!isWeb && status && !status.hasPassword && status.running && (
          <div className="text-xs text-red-400">
            尚未设置访问密码：目前仅本机（127.0.0.1）可访问，请设置密码后再用手机连接。
          </div>
        )}
        {!isWeb && status && !status.lanReachable && (
          <div className="text-xs text-amber-400">
            未检测到局域网地址，请确认电脑已连接 Wi-Fi 或网线。
          </div>
        )}
        {status?.error && <div className="text-xs text-red-400">服务器错误：{status.error}</div>}
        {message && <div className="text-xs text-emerald-400">{message}</div>}

        <div className="text-xs leading-5 text-zinc-500">
          手机浏览器访问的是同一套项目数据，并可调用相同的 AI 能力（消耗本机配置的额度）。首次在
          Windows 上监听端口时，防火墙可能弹出放行提示，请选择允许（专用网络）。
        </div>
      </Card>
    </div>
  )
}
