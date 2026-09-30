import type { ModelProbeResult, SettingsView } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { Markdown } from '../components/Markdown'
import { Badge, Button, Card, Label, Select, Textarea } from '../components/ui'
import { fmtDuration, fmtTokens } from '../lib/format'
import type { DonePayload } from '../lib/ipc'

export default function Playground() {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [probe, setProbe] = useState<ModelProbeResult | null>(null)
  const [model, setModel] = useState('')
  const [system, setSystem] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<DonePayload | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const outputEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void (async () => {
      const s = await window.api.settings.get()
      setSettings(s)
      setModel(
        (() => {
          const r = s.modelRouting.playground
          if (typeof r === 'string') return r || s.defaultModel
          if (!r) return s.defaultModel
          return r.provider && r.provider !== s.provider
            ? s.defaultModel
            : r.model || s.defaultModel
        })()
      )
      try {
        const p = await window.api.models.probe({})
        setProbe(p)
      } catch {
        setProbe(null)
      }
    })()
    const offDelta = window.api.llm.onDelta((id, text) => {
      if (id === requestIdRef.current) setOutput((prev) => prev + text)
    })
    const offDone = window.api.llm.onDone((id, payload) => {
      if (id === requestIdRef.current) {
        setResult(payload)
        setRunning(false)
      }
    })
    const offError = window.api.llm.onError((id, message) => {
      if (id === requestIdRef.current) {
        setError(message)
        setRunning(false)
      }
    })
    return () => {
      offDelta()
      offDone()
      offError()
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: dep 仅作重触发信号，加入会破坏语义
  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [output])

  const modelOptions = (() => {
    const ids = new Set<string>()
    if (probe)
      probe.models.forEach((m) => {
        ids.add(m)
      })
    settings?.customModels
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((m) => {
        ids.add(m)
      })
    if (model) ids.add(model)
    return [...ids]
  })()

  const send = (): void => {
    if (!input.trim() || !model || running) return
    setOutput('')
    setError('')
    setResult(null)
    setRunning(true)
    void window.api.llm
      .chat({
        model,
        system: system.trim() || undefined,
        messages: [{ role: 'user', content: input.trim() }],
        maxTokens: 4096,
        temperature: 0.7,
        purpose: 'playground'
      })
      .then((id) => {
        requestIdRef.current = id
      })
      .catch((err: unknown) => {
        setError((err as Error).message)
        setRunning(false)
      })
  }

  const stop = (): void => {
    if (requestIdRef.current) void window.api.llm.abort(requestIdRef.current)
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-full sm:w-64">
          <Label>模型</Label>
          <Select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={running}
            className="w-full"
          >
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex-1">
          <Label>System（文风/技能指令）</Label>
          <input
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            placeholder="例如：以古风网文的笔法写作，多用短句"
            disabled={running}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 outline-none focus:border-amber-600"
          />
        </div>
        {probe && (
          <div className="pt-4">
            <Badge tone={probe.source === 'endpoint' ? 'green' : 'default'}>
              模型列表: {probe.source === 'endpoint' ? '接口探测' : '内置'}
            </Badge>
          </div>
        )}
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4">
          {output ? (
            <Markdown text={output} className="text-sm leading-7 text-zinc-200" />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-zinc-600">
              {running ? '生成中…' : '输入内容开始试写，或先到「设置」配置 API Key'}
            </div>
          )}
          <div ref={outputEndRef} />
        </div>
        {(result || error) && (
          <div className="border-t border-zinc-800 px-4 py-2.5">
            {error ? (
              <div className="text-sm text-red-400">{error}</div>
            ) : result ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-400">
                <span>
                  输入{' '}
                  <span className="font-mono text-zinc-200">
                    {fmtTokens(result.usage.inputTokens)}
                  </span>
                </span>
                <span>
                  输出{' '}
                  <span className="font-mono text-zinc-200">
                    {fmtTokens(result.usage.outputTokens)}
                  </span>
                </span>
                {result.usage.cacheReadTokens > 0 && (
                  <span>
                    缓存读{' '}
                    <span className="font-mono text-emerald-400">
                      {fmtTokens(result.usage.cacheReadTokens)}
                    </span>
                  </span>
                )}
                {result.usage.cacheCreationTokens > 0 && (
                  <span>
                    缓存写{' '}
                    <span className="font-mono text-amber-400">
                      {fmtTokens(result.usage.cacheCreationTokens)}
                    </span>
                  </span>
                )}
                <span>
                  实际模型 <span className="font-mono text-zinc-200">{result.model}</span>
                </span>
                <span>
                  耗时{' '}
                  <span className="font-mono text-zinc-200">{fmtDuration(result.durationMs)}</span>
                </span>
                <span>停止原因 {result.stopReason ?? '-'}</span>
                <details className="w-full">
                  <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">
                    响应头（额度/限流字段探测）
                  </summary>
                  <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-500">
                    {JSON.stringify(result.headers, null, 2)}
                  </pre>
                </details>
              </div>
            ) : null}
          </div>
        )}
      </Card>

      <div>
        <Textarea
          rows={4}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send()
          }}
          placeholder="输入提示词，Ctrl+Enter 发送"
          disabled={running}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-zinc-600">Ctrl+Enter 发送</span>
          <div className="flex gap-2">
            {running ? (
              <Button variant="danger" onClick={stop}>
                停止
              </Button>
            ) : (
              <Button onClick={send} disabled={!input.trim() || !model}>
                发送
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
