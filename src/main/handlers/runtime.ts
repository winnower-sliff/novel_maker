// 中央同步器的数据源：一次拉回全部在途/近期运行与批量进度，
// 渲染端不依赖事件到达也能收敛 UI 状态（「推为加速、拉为兜底」）。
import type { PartialHandlerTable } from './context'
import { listRuns } from './stream'
import { allBatchesSnapshot } from './writeBatch'

export const runtimeHandlers = {
  'runtime:snapshot': () => ({ runs: listRuns(), batches: allBatchesSnapshot() })
} satisfies PartialHandlerTable
