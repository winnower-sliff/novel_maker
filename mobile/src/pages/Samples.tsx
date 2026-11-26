import { SAMPLE_UPLOAD } from '@shared/contract'
import type { Book, SampleFileInfo, SampleImportResult, SampleInfo } from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Cover } from '../components/Cover'
import { ErrorBox } from '../components/ErrorBox'
import { IconFileText, IconPlus } from '../components/icons'
import { PageShell } from '../components/PageShell'
import { SampleReader } from '../components/SampleReader'
import { UploadCancelled, uploadSampleText } from '../lib/sampleUpload'
import { toastError } from '../lib/toastStore'

function fmtChars(chars: number): string {
  return chars >= 10_000 ? `${(chars / 10_000).toFixed(1)} 万字` : `${chars.toLocaleString()} 字`
}

/** 导入回执：导入区可能在屏幕外，回执吸顶，停在哪一段点按钮都看得见 */
function importReceipt(res: SampleImportResult): string {
  const meta = `${fmtChars(res.chars)}${res.chapterCount ? ` · ${res.chapterCount} 章` : ''}`
  return res.originalName
    ? `已有同名的范文，这本另存为《${res.name}》：${meta}`
    : `已导入《${res.name}》：${meta}`
}

/**
 * 范文页（底部导航第二项）：范文卡（绑定 / 解绑到书、删除的两步确认、阅读入口）+ 两条导入通路——
 * 手机端直接选 txt（分片上传，自动识别编码）与电脑端 imports 文件夹。范文只增不改，没有「清空」入口。
 */
export default function Samples() {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [reading, setReading] = useState<SampleInfo | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  /** 上传进度；非空即「正在导入」 */
  const [upload, setUpload] = useState<{ name: string; sent: number; total: number } | null>(null)
  const cancelUpload = useRef(false)

  const {
    data: samples,
    isPending: samplesLoading,
    error: samplesError,
    isError: samplesFailed
  } = useQuery({
    queryKey: ['samples'],
    queryFn: async (): Promise<SampleInfo[]> => window.api.sample.list()
  })
  const {
    data: files,
    isPending: filesLoading,
    error: filesError,
    isError: filesFailed
  } = useQuery({
    queryKey: ['importFiles'],
    queryFn: async (): Promise<SampleFileInfo[]> => window.api.sample.listDir()
  })
  const { data: books } = useQuery({
    queryKey: ['books'],
    queryFn: async (): Promise<Book[]> => window.api.book.list()
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['samples'] })
    queryClient.invalidateQueries({ queryKey: ['importFiles'] })
    queryClient.invalidateQueries({ queryKey: ['books'] })
  }

  const doImport = async (fileName: string) => {
    setBusy(fileName)
    setMsg('')
    try {
      setMsg(importReceipt(await window.api.sample.import({ fileName })))
      refresh()
    } catch (e) {
      toastError(e, '导入失败')
    } finally {
      setBusy('')
    }
  }

  const pickFile = (file: File | undefined) => {
    if (!file) return
    if (!/\.txt$/i.test(file.name) && file.type && file.type !== 'text/plain') {
      toastError(new Error('只能导入 txt 文本文件'), '导入失败')
      return
    }
    const name = file.name.replace(/\.txt$/i, '')
    const chunks = Math.ceil(file.size / SAMPLE_UPLOAD.chunkBytes)
    setMsg('')
    setUpload({ name, sent: 0, total: chunks > 0 ? chunks : 1 })
    cancelUpload.current = false
    uploadSampleText(
      file,
      (sent, total) => setUpload({ name, sent, total }),
      () => cancelUpload.current
    )
      .then((res) => {
        setMsg(importReceipt(res))
        refresh()
      })
      .catch((e: unknown) => {
        if (!(e instanceof UploadCancelled)) toastError(e, `导入《${name}》失败`)
      })
      .finally(() => setUpload(null))
  }

  const stopUpload = () => {
    cancelUpload.current = true
  }

  const doToggle = async (bookId: string, sampleId: string, nextIds: string[]) => {
    if (!bookId) return
    setBusy(sampleId + bookId)
    try {
      await window.api.sample.attach(bookId, nextIds)
      refresh()
    } catch (e) {
      setMsg(`绑定失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
    }
  }

  const doDelete = async (sampleId: string) => {
    setBusy(sampleId)
    try {
      await window.api.sample.delete(sampleId)
      setConfirmDel(null)
      setMsg('已删除')
      refresh()
    } catch (e) {
      setMsg(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
    }
  }

  // 按书名排序：绑定会刷新 books，接口按最近更新排，不排的话点一本书它自己跳到最前
  const bindable = (books ?? [])
    .filter((b) => !b.archived && !b.draft)
    .sort((a, b) => a.title.localeCompare(b.title, 'zh'))
  const totalChars = samples?.reduce((n, s) => n + s.chars, 0) ?? 0

  return (
    <PageShell
      title="范文"
      subtitle={
        samples && samples.length > 0
          ? `共 ${samples.length} 本 · ${fmtChars(totalChars)}`
          : '写作时供导演翻阅的参考书'
      }
      action={
        <button
          type="button"
          disabled={upload !== null}
          className="inline-flex h-10 shrink-0 items-center gap-1 rounded-full bg-orange-600 pl-3 pr-4 text-sm font-semibold text-white active:bg-orange-700 disabled:opacity-50"
          onClick={() => fileInput.current?.click()}
        >
          <IconPlus size={16} />
          {upload ? '导入中…' : '导入 txt'}
        </button>
      }
      banner={
        upload ? (
          <div role="status" className="border-b border-orange-100 bg-orange-50 px-5 py-2.5">
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-xs text-orange-700">
                正在导入《{upload.name}》
              </span>
              <span className="shrink-0 text-xs tabular-nums text-orange-700">
                {Math.round((upload.sent / upload.total) * 100)}%
              </span>
              <button
                type="button"
                className="-my-1.5 min-h-10 shrink-0 rounded-full border border-orange-200 px-3 text-xs text-stone-600 active:bg-white"
                onClick={stopUpload}
              >
                取消
              </button>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-orange-100">
              <div
                className="h-full bg-orange-500 transition-all duration-300"
                style={{ width: `${(upload.sent / upload.total) * 100}%` }}
              />
            </div>
          </div>
        ) : undefined
      }
      bodyClass="flex flex-col"
    >
      {/* 操作回执吸顶：导入区在页面底部、范文卡在顶部，无论停在哪一段点按钮都看得见 */}
      {msg && (
        <div
          role="status"
          className="sticky top-0 z-10 -mx-5 border-b border-orange-100 bg-orange-50 px-5 py-2.5 text-center text-xs text-orange-700"
        >
          {msg}
        </div>
      )}

      {/* 两个列表任一拉不到就整段报错：断连时逐条显示「还没有」会让人以为数据没了。
          点重试后会回到加载态（没有数据的重新请求在 TanStack 里算 pending），所以加载态必须先判 */}
      {samplesLoading || filesLoading ? (
        <div className="flex flex-1 items-center justify-center py-16">
          <p className="text-sm text-stone-500">加载中…</p>
        </div>
      ) : (samplesFailed && !samples) || (filesFailed && !files) ? (
        <div className="flex flex-1 items-center justify-center py-10">
          <ErrorBox error={samplesError ?? filesError} onRetry={refresh} />
        </div>
      ) : (
        <>
          {samples && samples.length > 0 ? (
            <div className="space-y-3">
              {samples.map((s) => {
                const boundCount = (books ?? []).filter((b) =>
                  b.sampleSources?.includes(s.id)
                ).length
                const confirming = confirmDel === s.id
                return (
                  <div key={s.id} className="rounded-2xl border border-orange-100 bg-white p-3.5">
                    <div className="flex items-center gap-3.5">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-3.5 text-left"
                        onClick={() => setReading(s)}
                      >
                        <Cover
                          id={s.id}
                          name={s.name}
                          glyphSize={22}
                          className="h-16 w-12 shrink-0 rounded-md rounded-r-lg"
                        />
                        <span className="min-w-0">
                          <span className="line-clamp-2 block text-[15px] font-semibold leading-5">
                            {s.name}
                          </span>
                          <span className="mt-1 block text-xs text-stone-400">
                            {fmtChars(s.chars)}
                            {s.chapterCount ? ` · ${s.chapterCount} 章` : ''}
                          </span>
                          {/* 绑定数另起一行：挤在同一行时窄屏会把「本书」拆到下一行 */}
                          {boundCount > 0 && (
                            <span className="block text-xs text-stone-400">
                              已绑定 {boundCount} 本书
                            </span>
                          )}
                        </span>
                      </button>
                      {confirming ? null : (
                        <button
                          type="button"
                          className="flex h-10 shrink-0 items-center justify-center rounded-full border border-orange-200 px-4 text-xs font-medium text-orange-600 active:bg-orange-50"
                          onClick={() => setReading(s)}
                        >
                          阅读
                        </button>
                      )}
                    </div>
                    {/* 绑定胶囊：视觉保持小胶囊，命中区域用上下负 margin 撑到 40px；
                        行间距留足 12px，相邻两行的命中区不重叠 */}
                    {bindable.length > 0 && !confirming && (
                      <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-3 border-t border-orange-50 pt-3">
                        <span className="mr-1 text-[11px] text-stone-400">绑到书上</span>
                        {bindable.map((b) => {
                          const on = b.sampleSources?.includes(s.id) ?? false
                          return (
                            <button
                              key={b.id}
                              type="button"
                              aria-pressed={on}
                              disabled={busy === s.id + b.id}
                              className={
                                on
                                  ? '-my-1.5 rounded-full bg-orange-600 px-3 py-3 text-xs text-white disabled:opacity-50'
                                  : '-my-1.5 rounded-full border border-orange-200 px-3 py-3 text-xs text-stone-500 disabled:opacity-50'
                              }
                              onClick={() =>
                                doToggle(
                                  b.id,
                                  s.id,
                                  on
                                    ? (b.sampleSources ?? []).filter((x) => x !== s.id)
                                    : [...(b.sampleSources ?? []), s.id]
                                )
                              }
                            >
                              {on ? '✓ ' : ''}
                              {b.title}
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {confirming ? (
                      <div className="mt-3 flex items-center gap-2 rounded-xl bg-red-50 p-3">
                        <span className="flex-1 text-xs leading-relaxed text-red-600">
                          删除范文？绑定的书会自动解绑
                        </span>
                        <button
                          type="button"
                          disabled={busy === s.id}
                          className="h-10 shrink-0 rounded-full bg-red-600 px-4 text-xs font-medium text-white disabled:opacity-50"
                          onClick={() => doDelete(s.id)}
                        >
                          删除
                        </button>
                        <button
                          type="button"
                          className="h-10 shrink-0 rounded-full border border-orange-200 px-4 text-xs text-stone-500"
                          onClick={() => setConfirmDel(null)}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="-mb-3.5 mt-1.5 flex h-10 items-center text-xs text-stone-400 active:text-red-600"
                        onClick={() => setConfirmDel(s.id)}
                      >
                        删除这本范文
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-orange-200 px-4 py-6 text-center">
              <div className="text-sm text-stone-500">还没有范文</div>
              <div className="mt-1 text-xs leading-relaxed text-stone-400">
                点「导入 txt」从手机里选一本，或把 txt 放进电脑端数据目录的 imports
                文件夹再在下面导入
              </div>
            </div>
          )}

          <section className="mt-6">
            <h2 className="text-base font-bold">待导入</h2>
            <p className="mt-1 text-xs leading-relaxed text-stone-400">
              电脑端把 txt 放进数据目录的 imports 文件夹，这里点导入（全文入库，agent 按需翻阅）
            </p>
            {files && files.length > 0 ? (
              <div className="mt-3 space-y-2.5">
                {files.map((f) => (
                  <div
                    key={f.fileName}
                    className="flex items-center gap-3 rounded-2xl border border-orange-100 bg-white p-3"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-orange-600">
                      <IconFileText />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-stone-700">
                        {f.fileName}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-stone-400">
                        {f.preview.trim() || '（空文件）'}
                      </div>
                      <div className="text-[11px] text-stone-400">
                        {f.sizeBytes < 1048576
                          ? `${Math.max(1, Math.round(f.sizeBytes / 1024))} KB`
                          : `${(f.sizeBytes / 1048576).toFixed(1)} MB`}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busy === f.fileName}
                      className="h-10 shrink-0 rounded-full bg-orange-600 px-4 text-xs font-medium text-white active:bg-orange-700 disabled:opacity-50"
                      onClick={() => doImport(f.fileName)}
                    >
                      {busy === f.fileName ? '导入中…' : '导入'}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 rounded-2xl border border-dashed border-orange-200 px-4 py-5 text-center text-xs text-stone-400">
                （imports 目录暂无 txt 文件）
              </div>
            )}
          </section>
        </>
      )}

      {reading && (
        <SampleReader
          sample={{ id: reading.id, name: reading.name, chars: reading.chars }}
          onClose={() => setReading(null)}
        />
      )}
      {/* 选完同一个文件再选一次也要触发 change：每次用完把 value 清空 */}
      <input
        ref={fileInput}
        type="file"
        accept=".txt,text/plain"
        className="hidden"
        onChange={(e) => {
          pickFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </PageShell>
  )
}
