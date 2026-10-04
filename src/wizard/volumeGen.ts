import type { OutlineRunProgress } from '@shared/types'
import { useEffect, useState } from 'react'
import { fireCanonSync } from './canonStore'
import { startPipeline } from './pipeline'
import { loadProjectPlan, saveProjectPlan } from './wizardPlan'

/** 卷大纲生成结果（parsed=false 或零章 = 解析失败） */
export interface VolumeGenResult {
  parsed: boolean
  created: number
  updated: number
  skipped: number
  /** 全卷重写语义：已清除的旧正文章数（0 = 未清除；重写正文由用户在写作页主动触发） */
  cleared: number
  /** 全卷重写时直接删除的「埋于本卷」未回收伏笔条数 */
  foreRemoved: number
}

export interface VolumeGenOpts {
  projectId: string
  volume: number
  idea: string
  /** 节奏与硬性要求（原样透传给大纲生成 prompt，逐章严格执行） */
  rules?: string
  /** 通用规则（全书各卷适用，仅作用于大纲链路） */
  globalRules?: string
  startNo: number
  count: number
  /** 该卷已有正文 → 重写语义：清孤儿章 + 清除该卷全部旧正文/摘要（不自动重写，写作页主动触发） */
  hasWritten: boolean
  onDelta?: (t: string) => void
}

/** 每卷生成参数记忆：读-合并-写回 volumePlans（下次换卷预填） */
export async function rememberVolumePlan(
  projectId: string,
  volume: number,
  plan: { idea: string; startNo?: number; count: number; rules?: string }
): Promise<void> {
  const cur = await loadProjectPlan(projectId)
  const prev = cur?.volumePlans?.[String(volume)]
  await saveProjectPlan(projectId, {
    volumePlans: {
      ...(cur?.volumePlans ?? {}),
      [String(volume)]: {
        ...plan,
        startNo: plan.startNo ?? prev?.startNo,
        rules: plan.rules ?? prev?.rules
      }
    }
  })
}

/** 起始章号全自动推导：重写已有卷 = 该卷最小章号；新卷 = 全库最大章号 + 1 */
export function deriveStartNo(
  volume: number,
  items: Array<{ volume: number; chapterNo: number }>
): number {
  const volNos = items.filter((o) => o.volume === volume).map((o) => o.chapterNo)
  return volNos.length > 0 ? Math.min(...volNos) : Math.max(0, ...items.map((o) => o.chapterNo)) + 1
}

/**
 * 该项目是否有在途的大纲生成 run（主进程视角），并带回其流式文本尾部。
 * 页面切走/刷新后生成照常在后台跑（主进程 afterDone 落库）；
 * 组件重挂时据此恢复「生成中」busy 态与进度显示（tail 来自主进程注册表的 textTail），
 * 避免用户重复触发导致两个 run 并行互踩。
 * 完成通知与 outlines 缓存失效由中央同步器（runtimeSync）负责，这里只管 busy 态。
 */
export function useOutlineRunActive(projectId: string | null): {
  active: boolean
  tail: string
  progress: OutlineRunProgress | undefined
} {
  const [state, setState] = useState<{
    active: boolean
    tail: string
    progress: OutlineRunProgress | undefined
  }>({ active: false, tail: '', progress: undefined })
  useEffect(() => {
    if (!projectId) {
      setState({ active: false, tail: '', progress: undefined })
      return
    }
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = (): void => {
      void window.api.runtime
        .snapshot()
        .then((snap) => {
          if (stopped) return
          const run = snap.runs.find(
            (r) =>
              r.status === 'running' &&
              r.meta?.action === 'outline' &&
              r.meta?.projectId === projectId
          )
          const next = {
            active: !!run,
            tail: run?.textTail ?? '',
            progress: run?.progress
          }
          // 1s 轮询下避免无变化 re-render（progress 不变时保持原引用）
          setState((prev) =>
            prev.active === next.active &&
            prev.tail === next.tail &&
            JSON.stringify(prev.progress) === JSON.stringify(next.progress)
              ? prev
              : next
          )
          // 活跃期间 1s 轮询：驱动真进度条（主进程已做增量解析，快照很轻）
          if (run) timer = setTimeout(check, 1000)
        })
        .catch(() => {})
    }
    void check()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [projectId])
  return state
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
  globalRules?: string
  onDelta?: (t: string) => void
}): { done: Promise<string>; abort: () => void } {
  const { done, abort } = startPipeline(
    'volumeIdea',
    {
      projectId: opts.projectId,
      volume: opts.volume,
      idea: opts.idea,
      rules: opts.rules,
      globalRules: opts.globalRules
    },
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
  /** 优化本卷规则时可传入通用规则作兼容上下文（优化通用规则自身时勿传，避免自参考） */
  globalRules?: string
  onDelta?: (t: string) => void
}): { done: Promise<string>; abort: () => void } {
  const { done, abort } = startPipeline(
    'rulesRefine',
    {
      projectId: opts.projectId,
      volume: opts.volume,
      rules: opts.rules,
      globalRules: opts.globalRules
    },
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
 * → volumePlans 写回参数记忆（下次预填）→ hasWritten 时清理新范围外孤儿章并清除该卷旧正文/摘要。
 * 抛错透传给调用方展示。
 */
export function generateVolume(opts: VolumeGenOpts): {
  done: Promise<VolumeGenResult>
  abort: () => void
} {
  const { projectId, volume, idea, startNo, count, hasWritten, onDelta } = opts
  // 旧章集合必须在管线启动前捕获：生成后列表已变，事后拉取会漏判孤儿章
  const oldVolPromise = window.api.novel.outlines(projectId)
  // 启动即写参数记忆与当前卷（单次读-合并-写）：完成前参数只存在组件 state 里，
  // 不立刻落库的话生成中切页/刷新重挂会被旧记忆或默认值（outlineCount=20）覆盖表单
  void (async () => {
    try {
      const cur = await loadProjectPlan(projectId)
      await saveProjectPlan(projectId, {
        volume,
        volumePlans: {
          ...(cur?.volumePlans ?? {}),
          [String(volume)]: { idea, startNo, count, rules: opts.rules ?? '' }
        }
      })
    } catch {
      // 记忆写入失败不阻塞生成本身
    }
  })()
  const { done, abort } = startPipeline(
    'outline',
    {
      projectId,
      idea,
      volume,
      startNo,
      count,
      allowUpdate: true,
      rules: opts.rules?.trim() || undefined,
      globalRules: opts.globalRules?.trim() || undefined
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
    if (!r.parsed || r.created + r.updated === 0) return { ...r, cleared: 0, foreRemoved: 0 }
    // 反向闭环：新大纲导入成功后自动同步世界观与人物（后台运行，不阻塞后续写作）
    fireCanonSync(projectId, volume)
    // 参数记忆：写回 volumePlans，下次重生成预填
    await rememberVolumePlan(projectId, volume, {
      idea,
      startNo,
      count,
      rules: opts.rules?.trim() || undefined
    })
    let cleared = 0
    let foreRemoved = 0
    if (hasWritten) {
      const old = await oldVolPromise
      const fresh = await window.api.novel.outlines(projectId)
      const newNos = new Set(fresh.filter((o) => o.volume === volume).map((o) => o.chapterNo))
      for (const o of old.filter((x) => x.volume === volume && !newNos.has(x.chapterNo))) {
        await window.api.novel.outlineDelete(o.id)
      }
      // 旧稿伏笔随之废弃：埋于本卷章号范围的未回收伏笔直接删除（旧正文已作废，台账引用的剧情线不复存在）
      const volNos = old.filter((x) => x.volume === volume).map((x) => x.chapterNo)
      if (volNos.length > 0) {
        const lo = Math.min(...volNos)
        const hi = Math.max(...volNos)
        const fores = await window.api.novel.foreshadows(projectId)
        for (const f of fores) {
          if (f.status !== 'open') continue
          const m = /第(\d+)章/.exec(f.plantedChapter ?? '')
          const no = m ? Number(m[1]) : NaN
          if (no >= lo && no <= hi) {
            await window.api.novel.foreshadowDelete(f.id)
            foreRemoved++
          }
        }
      }
      // 旧正文即废稿：立即清除该卷正文/摘要/嵌入并把大纲降回草稿（写作页回到「未写」）；
      // 不自动批量重写，是否写、何时写由用户在写作页主动触发
      cleared = (await window.api.novel.clearVolumeContent(projectId, volume)).removed
    }
    return {
      parsed: r.parsed,
      created: r.created,
      updated: r.updated,
      skipped: r.skipped,
      cleared,
      foreRemoved
    }
  }
  return { done: finish(), abort }
}
