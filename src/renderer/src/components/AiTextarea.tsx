import type { ProviderId } from '@shared/providers'
import {
  type ChangeEvent,
  memo,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'
import { chatStream } from '../lib/ipc'
import { EngineSelect } from './EngineSelect'
import { Button, Input, Textarea } from './ui'

type AiMode = 'idle' | 'input' | 'generating' | 'preview'

interface AiTextareaProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  system?: string
  context?: string
}

const DEFAULT_SYSTEM =
  '你是网文创作助手。根据指令改写用户选中的文本片段，保持与上下文风格一致，只输出改写后的文本，不要任何解释或前后缀。'

const QUICK_CHIPS = ['扩写细节', '更简洁', '要点化', '换个说法']

const FLUSH_THROTTLE_MS = 100

const MemoTextarea = memo(Textarea)

function buildPrompt(context: string | undefined, picked: string, instruction: string): string {
  const parts: string[] = []
  if (context) parts.push(`【上下文】\n${context}`)
  parts.push(`【选中片段】\n${picked}`)
  parts.push(`【指令】\n${instruction}`)
  return parts.join('\n\n')
}

export function AiTextarea({
  value,
  onChange,
  placeholder,
  className = '',
  system,
  context
}: AiTextareaProps) {
  const [mode, setMode] = useState<AiMode>('idle')
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const [instruction, setInstruction] = useState('')
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [engine, setEngine] = useState<ProviderId | ''>('')
  const selRef = useRef<{ start: number; end: number } | null>(null)
  const abortRef = useRef<(() => void) | null>(null)
  const abortedRef = useRef(false)
  const previewRef = useRef<HTMLPreElement | null>(null)
  const modeRef = useRef<AiMode>(mode)
  const onChangeRef = useRef(onChange)
  const resultRef = useRef('')
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFlushAt = useRef(0)

  modeRef.current = mode
  onChangeRef.current = onChange

  // biome-ignore lint/correctness/useExhaustiveDependencies: dep 仅作重触发信号，加入会破坏语义
  useEffect(() => {
    const el = previewRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [result])

  useEffect(
    () => () => {
      abortedRef.current = true
      abortRef.current?.()
      if (flushTimer.current) clearTimeout(flushTimer.current)
    },
    []
  )

  const clearFlush = useCallback((): void => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
  }, [])

  const flushResult = (): void => {
    clearFlush()
    lastFlushAt.current = Date.now()
    setResult(resultRef.current)
  }

  const clearResult = useCallback((): void => {
    clearFlush()
    resultRef.current = ''
    setResult('')
  }, [clearFlush])

  const onDelta = (t: string): void => {
    resultRef.current += t
    if (flushTimer.current) return
    const wait = Math.max(0, FLUSH_THROTTLE_MS - (Date.now() - lastFlushAt.current))
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null
      flushResult()
    }, wait)
  }

  const resetAi = (): void => {
    abortRef.current?.()
    abortRef.current = null
    setMode('idle')
    clearResult()
    setError(null)
    setInstruction('')
  }

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>): void => {
      if (modeRef.current === 'generating') return
      if (modeRef.current !== 'idle') {
        abortRef.current?.()
        abortRef.current = null
        setMode('idle')
        clearResult()
        setError(null)
        setInstruction('')
      }
      selRef.current = null
      setSelection(null)
      onChangeRef.current(e.target.value)
    },
    [clearResult]
  )

  const handleSelect = useCallback((e: SyntheticEvent<HTMLTextAreaElement>): void => {
    if (modeRef.current !== 'idle') return
    const el = e.currentTarget
    const sel =
      el.selectionStart !== el.selectionEnd
        ? { start: el.selectionStart, end: el.selectionEnd }
        : null
    selRef.current = sel
    setSelection(sel)
  }, [])

  const runAi = (ins: string): void => {
    const sel = selRef.current
    if (!sel || !ins.trim()) return
    const picked = value.slice(sel.start, sel.end)
    setInstruction(ins)
    setMode('generating')
    clearResult()
    setError(null)
    abortedRef.current = false
    const { done, abort } = chatStream(
      {
        model: '',
        system: system ?? DEFAULT_SYSTEM,
        messages: [{ role: 'user', content: buildPrompt(context, picked, ins.trim()) }],
        maxTokens: 2048,
        temperature: 0.7,
        purpose: 'polish',
        ...(engine ? { provider: engine } : {})
      },
      onDelta
    )
    abortRef.current = abort
    done
      .then(() => {
        abortRef.current = null
        flushResult()
        setMode('preview')
      })
      .catch((err: unknown) => {
        abortRef.current = null
        if (abortedRef.current) {
          clearResult()
          setMode('input')
          return
        }
        flushResult()
        setError(err instanceof Error ? err.message : String(err))
        setMode('preview')
      })
  }

  const applyResult = (): void => {
    const sel = selRef.current
    if (!sel) return
    onChange(value.slice(0, sel.start) + result + value.slice(sel.end))
    resetAi()
  }

  const selectedLen = selection ? selection.end - selection.start : 0

  return (
    <div className={`flex min-h-0 flex-col ${className}`}>
      <MemoTextarea
        className="min-h-48 flex-1"
        value={value}
        onChange={handleChange}
        onSelect={handleSelect}
        placeholder={placeholder}
        disabled={mode === 'generating'}
      />

      {mode === 'idle' &&
        (selection ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs text-zinc-500">
            <span>已选中 {selectedLen} 字</span>
            <Button
              variant="ghost"
              className="px-2 py-0.5 text-xs"
              onClick={() => {
                setInstruction('')
                setMode('input')
              }}
            >
              AI 改写
            </Button>
          </div>
        ) : (
          <div className="mt-1.5 text-[11px] text-zinc-600">选中文字后可用 AI 改写所选片段</div>
        ))}

      {mode === 'input' && (
        <div className="mt-1.5 space-y-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] text-zinc-500">对选中的 {selectedLen} 字执行指令</div>
            <EngineSelect
              value={engine}
              onChange={(p) => setEngine(p ?? '')}
              className="w-28 py-0.5 text-[11px]"
            />
          </div>
          <div className="flex gap-1.5">
            <Input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="例：扩写成三段，补充细节"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) runAi(instruction)
              }}
            />
            <Button
              className="shrink-0 px-2.5 py-1 text-xs"
              onClick={() => runAi(instruction)}
              disabled={!instruction.trim()}
            >
              生成
            </Button>
            <Button variant="ghost" className="shrink-0 px-2.5 py-1 text-xs" onClick={resetAi}>
              取消
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_CHIPS.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => runAi(c)}
                className="cursor-pointer rounded-full bg-zinc-800 px-2.5 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      {(mode === 'generating' || mode === 'preview') && (
        <div className="mt-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
          {error ? (
            <div className="text-xs leading-5 text-red-300">出错：{error}</div>
          ) : (
            <pre
              ref={previewRef}
              className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-zinc-300"
            >
              {result || (mode === 'generating' ? '等待模型输出…' : '')}
            </pre>
          )}
          <div className="mt-1.5 flex justify-end gap-1.5">
            {mode === 'generating' ? (
              <Button
                variant="ghost"
                className="px-2 py-0.5 text-xs"
                onClick={() => {
                  abortedRef.current = true
                  abortRef.current?.()
                }}
              >
                中断
              </Button>
            ) : (
              <>
                {error ? (
                  <Button
                    variant="ghost"
                    className="px-2 py-0.5 text-xs"
                    onClick={() => runAi(instruction)}
                  >
                    重试
                  </Button>
                ) : (
                  <>
                    <Button className="px-2 py-0.5 text-xs" onClick={applyResult}>
                      替换选区
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 py-0.5 text-xs"
                      onClick={() => runAi(instruction)}
                    >
                      重新生成
                    </Button>
                  </>
                )}
                <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={resetAi}>
                  取消
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
