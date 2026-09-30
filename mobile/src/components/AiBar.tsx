import { useCallback, useEffect, useRef, useState } from 'react'
import { chatStream } from '@mobile/lib/stream'
import { Button, Input, Spinner } from './ui'

type Mode = 'idle' | 'input' | 'generating' | 'preview'
type Action = 'rewrite' | 'continue'

const REWRITE_SYSTEM =
  '你是网文创作助手。根据指令改写用户选中的文本片段，保持与上下文风格一致，只输出改写后的文本，不要任何解释或前后缀。'
const CONTINUE_SYSTEM =
  '你是网文创作助手。根据上文与指令续写小说正文，保持风格与人称一致，只输出续写内容，不要重复上文，不要任何解释。'

const REWRITE_CHIPS = ['扩写细节', '更简洁', '换个说法', '加强画面感']
const CONTINUE_CHIPS = ['自然续写 500 字左右', '推进剧情', '加入对话', '制造悬念']

interface Props {
  value: string
  onChange: (v: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  disabled?: boolean
}

export function AiBar({ value, onChange, textareaRef, disabled }: Props) {
  const [mode, setMode] = useState<Mode>('idle')
  const [action, setAction] = useState<Action>('rewrite')
  const [selLen, setSelLen] = useState(0)
  const [instruction, setInstruction] = useState('')
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<(() => void) | null>(null)
  const abortedRef = useRef(false)
  const resultRef = useRef('')
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFlushAt = useRef(0)

  // 触屏长按选择文本不触发 React onSelect，监听 document selectionchange
  useEffect(() => {
    const update = (): void => {
      const el = textareaRef.current
      if (!el || mode !== 'idle') return
      if (document.activeElement !== el) return
      setSelLen(el.selectionEnd - el.selectionStart)
    }
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [textareaRef, mode])

  useEffect(
    () => () => {
      abortedRef.current = true
      abortRef.current?.()
      if (flushTimer.current) clearTimeout(flushTimer.current)
    },
    []
  )

  const flushResult = useCallback((): void => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
    lastFlushAt.current = Date.now()
    setResult(resultRef.current)
  }, [])

  const onDelta = useCallback(
    (t: string): void => {
      resultRef.current += t
      if (flushTimer.current) return
      const wait = Math.max(0, 100 - (Date.now() - lastFlushAt.current))
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null
        flushResult()
      }, wait)
    },
    [flushResult]
  )

  const reset = useCallback((): void => {
    abortRef.current?.()
    abortRef.current = null
    setMode('idle')
    resultRef.current = ''
    flushResult()
    setError(null)
    setInstruction('')
  }, [flushResult])

  const readSelection = (): { start: number; end: number } | null => {
    const el = textareaRef.current
    if (!el) return null
    return el.selectionStart !== el.selectionEnd
      ? { start: el.selectionStart, end: el.selectionEnd }
      : null
  }

  const openSheet = (next: Action): void => {
    const sel = readSelection()
    if (next === 'rewrite' && !sel) return
    setAction(next)
    setMode('input')
  }

  const run = (ins: string): void => {
    const el = textareaRef.current
    if (!el) return
    const sel = readSelection()
    const cursor = sel ? sel.start : el.selectionStart
    let user = ''
    let system: string
    if (action === 'rewrite') {
      if (!sel) return
      const picked = value.slice(sel.start, sel.end)
      const context = value.slice(Math.max(0, sel.start - 600), sel.start)
      const parts: string[] = []
      if (context) parts.push(`【上下文】\n…${context}`)
      parts.push(`【选中片段】\n${picked}`)
      parts.push(`【指令】\n${ins}`)
      user = parts.join('\n\n')
      system = REWRITE_SYSTEM
    } else {
      const context = value.slice(Math.max(0, cursor - 1200), cursor)
      user = `【上文】\n…${context}\n\n【指令】\n${ins || '衔接上文自然续写 500 字左右'}`
      system = CONTINUE_SYSTEM
    }
    abortedRef.current = false
    setMode('generating')
    resultRef.current = ''
    setResult('')
    setError(null)
    const { done, abort } = chatStream(
      {
        model: '',
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: action === 'continue' ? 4096 : 2048,
        temperature: 0.7,
        purpose: 'polish'
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
          reset()
          return
        }
        flushResult()
        setError(err instanceof Error ? err.message : String(err))
        setMode('preview')
      })
  }

  const apply = (): void => {
    const el = textareaRef.current
    if (!el) return
    const sel = readSelection()
    if (action === 'rewrite') {
      if (!sel) return
      onChange(value.slice(0, sel.start) + resultRef.current + value.slice(sel.end))
    } else {
      const cursor = sel ? sel.end : el.selectionStart
      const insert = resultRef.current
      onChange(value.slice(0, cursor) + insert + value.slice(cursor))
    }
    reset()
  }

  const chips = action === 'rewrite' ? REWRITE_CHIPS : CONTINUE_CHIPS
  const busy = mode === 'generating'

  return (
    <>
      <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {selLen > 0 ? (
          <>
            <span className="text-xs text-zinc-500">已选 {selLen} 字</span>
            <Button
              className="ml-auto px-3 py-1.5 text-xs"
              disabled={disabled}
              onClick={() => openSheet('rewrite')}
            >
              AI 改写
            </Button>
          </>
        ) : (
          <>
            <span className="text-xs text-zinc-600">选中文字可 AI 改写</span>
            <Button
              variant="ghost"
              className="ml-auto px-3 py-1.5 text-xs"
              disabled={disabled}
              onClick={() => openSheet('continue')}
            >
              AI 续写
            </Button>
          </>
        )}
      </div>

      {mode !== 'idle' && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/60" onClick={mode === 'input' ? reset : undefined} />
          <div className="relative rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="mb-2 text-xs font-medium text-zinc-400">
              {action === 'rewrite' ? `AI 改写选中的 ${selLen} 字` : 'AI 续写'}
            </div>
            {mode === 'input' && (
              <div className="space-y-2.5">
                <Input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder={action === 'rewrite' ? '例：扩写成三段，补充细节' : '例：引入一个意外访客（可留空）'}
                />
                <div className="flex flex-wrap gap-1.5">
                  {chips.map((c) => (
                    <button
                      type="button"
                      key={c}
                      onClick={() => {
                        setInstruction(c)
                        run(c)
                      }}
                      className="cursor-pointer rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 active:bg-zinc-700"
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2 pt-1">
                  <Button className="flex-1" disabled={!instruction.trim()} onClick={() => run(instruction)}>
                    生成
                  </Button>
                  <Button variant="ghost" className="flex-1" onClick={reset}>
                    取消
                  </Button>
                </div>
              </div>
            )}
            {(busy || mode === 'preview') && (
              <div className="space-y-2.5">
                <div className="max-h-[38vh] overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                  {error ? (
                    <div className="text-xs leading-5 text-red-300">出错：{error}</div>
                  ) : (
                    <pre className="whitespace-pre-wrap text-sm leading-6 text-zinc-300">
                      {result || (busy ? '等待模型输出…' : '')}
                    </pre>
                  )}
                </div>
                <div className="flex gap-2">
                  {busy ? (
                    <>
                      <Button
                        variant="ghost"
                        className="flex-1"
                        onClick={() => {
                          abortedRef.current = true
                          abortRef.current?.()
                        }}
                      >
                        <Spinner className="h-3.5 w-3.5" /> 中断
                      </Button>
                    </>
                  ) : (
                    <>
                      {!error && (
                        <Button className="flex-1" onClick={apply}>
                          {action === 'rewrite' ? '替换选区' : '插入正文'}
                        </Button>
                      )}
                      {error && (
                        <Button className="flex-1" onClick={() => run(instruction)}>
                          重试
                        </Button>
                      )}
                      <Button variant="ghost" className="flex-1" onClick={() => run(instruction)}>
                        重新生成
                      </Button>
                      <Button variant="ghost" onClick={reset}>
                        取消
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
