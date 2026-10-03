import { startPipeline } from './pipeline'
import { loadProjectPlan, saveProjectPlan } from './wizardPlan'

/** 卷大纲生成结果（parsed=false 或零章 = 解析失败） */
export interface VolumeGenResult {
  parsed: boolean
  created: number
  updated: number
  skipped: number
  /** 触发全卷重写时：已开始批量重写的章数（0 = 未触发批量） */
  rewriting: number
}

export interface VolumeGenOpts {
  projectId: string
  volume: number
  idea: string
  /** 节奏与硬性要求（原样透传给大纲生成 prompt，逐章严格执行） */
  rules?: string
  startNo: number
  count: number
  /** 该卷已有正文 → 重写语义：清孤儿章 + write:batchStart 全卷覆盖重写 */
  hasWritten: boolean
  onDelta?: (t: string) => void
}

/** 每卷生成参数记忆：读-合并-写回 volumePlans（下次换卷预填） */
export async function rememberVolumePlan(
  projectId: string,
  volume: number,
  plan: { idea: string; startNo: number; count: number; rules?: string }
): Promise<void> {
  const cur = await loadProjectPlan(projectId)
  const prev = cur?.volumePlans?.[String(volume)]
  await saveProjectPlan(projectId, {
    volumePlans: {
      ...(cur?.volumePlans ?? {}),
      [String(volume)]: { ...plan, rules: plan.rules ?? prev?.rules }
    }
  })
}

/**
 * 卷创意起草（两端共用）：把 idea 框内的简短要求扩写成正式卷创意（不落库）。
 * 抛错透传给调用方展示；成功后调用方写回 volumePlans 记忆。
 */
export function generateVolumeIdea(opts: {
  projectId: string
  volume: number
  idea: string
  rules?: string
  onDelta?: (t: string) => void
}): { done: Promise<string>; abort: () => void } {
  const { done, abort } = startPipeline(
    'volumeIdea',
    { projectId: opts.projectId, volume: opts.volume, idea: opts.idea, rules: opts.rules },
    opts.onDelta
  )
  return {
    done: done.then((r) => {
      const idea = (r.data as { idea?: string } | undefined)?.idea ?? ''
      if (!idea.trim()) throw new Error('AI 未输出有效卷创意，请重试')
      return idea
    }),
    abort
  }
}

/** 规则优化（两端共用）：把规则框内的粗糙要求改详实，结果由调用方回填（用户确认后生效） */
export function generateRulesRefine(opts: {
  projectId: string
  volume: number
  rules: string
  onDelta?: (t: string) => void
}): { done: Promise<string>; abort: () => void } {
  const { done, abort } = startPipeline(
    'rulesRefine',
    { projectId: opts.projectId, volume: opts.volume, rules: opts.rules },
    opts.onDelta
  )
  return {
    done: done.then((r) => {
      const rules = (r.data as { rules?: string } | undefined)?.rules ?? ''
      if (!rules.trim()) throw new Error('AI 未输出有效规则，请重试')
      return rules
    }),
    abort
  }
}

/**
 * 生成/重写一卷大纲（桌面/移动共用）：outline 管线（allowUpdate:true，重生成同卷覆盖同章号）
 * → volumePlans 写回参数记忆（下次预填）→ hasWritten 时清理新范围外孤儿章并批量重写该卷正文。
 * 抛错透传给调用方展示。
 */
export function generateVolume(opts: VolumeGenOpts): {
  done: Promise<VolumeGenResult>
  abort: () => void
} {
  const { projectId, volume, idea, startNo, count, hasWritten, onDelta } = opts
  // 旧章集合必须在管线启动前捕获：生成后列表已变，事后拉取会漏判孤儿章
  const oldVolPromise = window.api.novel.outlines(projectId)
  const { done, abort } = startPipeline(
    'outline',
    {
      projectId,
      idea,
      volume,
      startNo,
      count,
      allowUpdate: true,
      rules: opts.rules?.trim() || undefined
    },
    onDelta
  )
  const finish = async (): Promise<VolumeGenResult> => {
    const r = (await done).data as {
      created: number
      updated: number
      skipped: number
      parsed: boolean
    }
    if (!r.parsed || r.created + r.updated === 0) return { ...r, rewriting: 0 }
    // 参数记忆：写回 volumePlans，下次重生成预填
    await rememberVolumePlan(projectId, volume, {
      idea,
      startNo,
      count,
      rules: opts.rules?.trim() || undefined
    })
    let rewriting = 0
    if (hasWritten) {
      const old = await oldVolPromise
      const fresh = await window.api.novel.outlines(projectId)
      const newNos = new Set(fresh.filter((o) => o.volume === volume).map((o) => o.chapterNo))
      for (const o of old.filter((x) => x.volume === volume && !newNos.has(x.chapterNo))) {
        await window.api.novel.outlineDelete(o.id)
      }
      const volIds = (await window.api.novel.outlines(projectId))
        .filter((o) => o.volume === volume)
        .sort((a, b) => a.chapterNo - b.chapterNo)
        .map((o) => o.id)
      if (volIds.length > 0) {
        await window.api.write.batchStart({ projectId, ids: volIds })
        rewriting = volIds.length
      }
    }
    return {
      parsed: r.parsed,
      created: r.created,
      updated: r.updated,
      skipped: r.skipped,
      rewriting
    }
  }
  return { done: finish(), abort }
}
