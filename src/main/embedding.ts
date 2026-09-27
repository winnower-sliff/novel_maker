import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getDb } from './db'
import { getChapterByOutline, getSummary, listCharacters, listOutlines, listProjects, listWorldbuild } from './store'

/**
 * 本地语义检索：transformers.js + bge-small-zh-v1.5（ONNX int8，约 25MB，首用时下载）。
 * 模型不可用时自动降级（调用方拿到空结果回退关键词/图谱路径），不影响任何既有功能。
 */

const MODEL_ID = 'Xenova/bge-small-zh-v1.5'
const MAX_TEXT_CHARS = 1200
const CONCURRENCY = 8

interface EmbeddingConfig {
  enabled: boolean
}

interface ModuleState {
  pipe: unknown
  loading: Promise<unknown> | null
  loadError: string
  downloading: boolean
  progress: number
  queue: Promise<void>
}

type FeatureExtractionPipeline = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<Array<{ data: number[] }>>

const state: ModuleState = { pipe: null, loading: null, loadError: '', downloading: false, progress: 0, queue: Promise.resolve() }

function configPath(): string {
  return join(app.getPath('userData'), 'embedding.json')
}

function readConfig(): EmbeddingConfig {
  try {
    if (existsSync(configPath())) {
      const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<EmbeddingConfig>
      return { enabled: raw.enabled !== false }
    }
  } catch {
    /* 配置损坏时按默认处理 */
  }
  return { enabled: true }
}

function writeConfig(c: EmbeddingConfig): void {
  writeFileSync(configPath(), JSON.stringify(c, null, 2), 'utf8')
}

export function isEmbeddingEnabled(): boolean {
  return readConfig().enabled
}

export function setEmbeddingEnabled(v: boolean): void {
  writeConfig({ enabled: v })
}

async function ensurePipeline(): Promise<FeatureExtractionPipeline> {
  if (state.pipe) return state.pipe as FeatureExtractionPipeline
  if (!isEmbeddingEnabled()) throw new Error('语义检索已在设置中关闭')
  if (state.loadError) throw new Error(state.loadError)
  if (!state.loading) {
    state.loading = (async () => {
      const cacheDir = join(app.getPath('userData'), 'model-cache')
      mkdirSync(cacheDir, { recursive: true })
      const mod = (await import('@huggingface/transformers')) as unknown as {
        env: Record<string, unknown>
        pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>
      }
      mod.env.cacheDir = cacheDir
      if (process.env.HF_ENDPOINT) mod.env.remoteHost = process.env.HF_ENDPOINT
      state.downloading = true
      state.progress = 0
      const pipe = await mod.pipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8',
        progress_callback: (info: { status?: string; progress?: number }) => {
          if (info.status === 'progress' && typeof info.progress === 'number') {
            state.progress = Math.max(0, Math.min(100, info.progress))
          } else if (info.status === 'ready' || info.status === 'done') {
            state.downloading = false
          }
        }
      })
      state.pipe = pipe
      state.downloading = false
      state.progress = 100
      return pipe
    })().catch((err: unknown) => {
      state.loadError = `本地嵌入模型不可用：${(err as Error)?.message ?? String(err)}`
      state.downloading = false
      throw new Error(state.loadError)
    })
  }
  await state.loading
  return state.pipe as FeatureExtractionPipeline
}

export function getEmbeddingStatus(projectId?: string): {
  available: boolean
  enabled: boolean
  reason: string
  model: string
  count: number
  downloading: boolean
  progress: number
} {
  const enabled = isEmbeddingEnabled()
  let count = 0
  try {
    if (projectId) {
      const r = getDb()
        .prepare('SELECT COUNT(*) AS c FROM embeddings WHERE project_id = ?')
        .get(projectId) as { c: number }
      count = Number(r.c)
    } else {
      const r = getDb().prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }
      count = Number(r.c)
    }
  } catch {
    /* db 未初始化时返回 0 */
  }
  return {
    available: enabled && !state.loadError && (!!state.pipe || !state.loading),
    enabled,
    reason: state.loadError,
    model: MODEL_ID,
    count,
    downloading: state.downloading,
    progress: state.progress
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > MAX_TEXT_CHARS ? t.slice(0, MAX_TEXT_CHARS) : t
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const pipe = await ensurePipeline()
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += CONCURRENCY) {
    const batch = texts.slice(i, i + CONCURRENCY)
    const result = await pipe(batch.map(clip), { pooling: 'mean', normalize: true })
    for (const r of result) out.push(r.data)
  }
  return out
}

function upsertRow(projectId: string, kind: string, refId: string, text: string, vec: number[]): void {
  const db = getDb()
  const blob = Buffer.from(new Float32Array(vec).buffer)
  db.prepare(
    `INSERT INTO embeddings (id, project_id, kind, ref_id, text_hash, vec, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, kind, ref_id) DO UPDATE SET text_hash = excluded.text_hash, vec = excluded.vec, updated_at = excluded.updated_at`
  ).run(randomUUID(), projectId, kind, refId, hashText(text), blob, Date.now())
}

/** 异步嵌入（不阻塞调用方）；失败静默降级。通过内部队列串行避免并发加载模型。 */
export function enqueueEmbedding(projectId: string, kind: string, refId: string, text: string): void {
  if (!isEmbeddingEnabled() || !text.trim()) return
  const db = getDb()
  const existing = db
    .prepare('SELECT text_hash FROM embeddings WHERE project_id = ? AND kind = ? AND ref_id = ?')
    .get(projectId, kind, refId) as { text_hash: string } | undefined
  if (existing && existing.text_hash === hashText(text)) return
  state.queue = state.queue
    .then(async () => {
      const [vec] = await embedTexts([text])
      upsertRow(projectId, kind, refId, text, vec)
    })
    .catch(() => {
      /* 降级：语义检索暂不可用 */
    })
}

export function deleteEmbeddings(projectId: string, kind: string, refIds?: string[]): void {
  const db = getDb()
  if (!refIds) {
    db.prepare('DELETE FROM embeddings WHERE project_id = ? AND kind = ?').run(projectId, kind)
    return
  }
  const del = db.prepare('DELETE FROM embeddings WHERE project_id = ? AND kind = ? AND ref_id = ?')
  for (const id of refIds) del.run(projectId, kind, id)
}

/** 按 kind+refId 清除（跨项目；删除实体但只有 id 时用） */
export function deleteEmbeddingsByRef(kind: string, refId: string): void {
  getDb().prepare('DELETE FROM embeddings WHERE kind = ? AND ref_id = ?').run(kind, refId)
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  return dot
}

export interface SemanticHit {
  kind: string
  refId: string
  score: number
}

/** 语义检索：返回按相似度降序的命中；模型不可用/未启用时返回空数组（调用方自行回退）。 */
export async function semanticSearch(
  projectId: string,
  query: string,
  kinds: string[],
  k = 8
): Promise<SemanticHit[]> {
  if (!isEmbeddingEnabled() || !query.trim() || kinds.length === 0) return []
  try {
    const [qv] = await embedTexts([query])
    const rows = getDb()
      .prepare('SELECT kind, ref_id, vec FROM embeddings WHERE project_id = ?')
      .all(projectId) as Array<{ kind: string; ref_id: string; vec: Uint8Array }>
    const qf = new Float32Array(qv)
    const hits: SemanticHit[] = []
    for (const r of rows) {
      if (!kinds.includes(r.kind)) continue
      const vf = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
      hits.push({ kind: r.kind, refId: r.ref_id, score: cosine(qf, vf) })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, k)
  } catch {
    return []
  }
}

/** 重建指定项目（或全部项目）的嵌入索引。返回已嵌入条数；失败抛出原因。 */
export async function rebuildEmbeddings(projectId?: string): Promise<number> {
  const ids = projectId ? [projectId] : listProjects().map((p) => p.id)
  let n = 0
  for (const pid of ids) {
    for (const e of listWorldbuild(pid)) {
      enqueueEmbedding(pid, 'worldbuild', e.id, `${e.title} ${e.keys} ${e.tags} ${e.content}`)
      n++
    }
    for (const c of listCharacters(pid)) {
      enqueueEmbedding(pid, 'character', c.id, `${c.name} ${c.role} ${c.tags} ${c.card}`)
      n++
    }
    for (const o of listOutlines(pid)) {
      const chapter = getChapterByOutline(o.id)
      const s = chapter ? getSummary(chapter.id) : null
      if (s) {
        enqueueEmbedding(pid, 'summary', o.id, `第${o.chapterNo}章 ${o.title}：${s.summary} ${s.events.join('；')}`)
        n++
      }
    }
  }
  await state.queue
  return n
}
