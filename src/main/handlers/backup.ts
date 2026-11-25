import { basename } from 'node:path'
import { restoreBackup } from '../backup.js'
import { listBackups, snapshotDb } from '../db.js'
import { listJobsFor, recoverJobsOnBoot } from '../jobs.js'
import type { HandlerTable } from './types.js'

export const backupHandlers: Pick<
  HandlerTable,
  'backup:list' | 'backup:create' | 'backup:restore'
> = {
  'backup:list': () => listBackups(),
  'backup:create': () => {
    const name = basename(snapshotDb('manual'))
    const entry = listBackups().find((e) => e.name === name)
    if (!entry) throw new Error('备份已写入数据目录，但读取备份信息失败')
    return entry
  },
  'backup:restore': (_ctx, [name]) => {
    const busy = listJobsFor().some(
      (j) => j.state === 'running' || j.state === 'queued' || j.state === 'waiting_user'
    )
    if (busy) throw new Error('有写作任务还没结束，等它结束或取消后再恢复')
    const result = restoreBackup(name)
    recoverJobsOnBoot()
    return result
  }
}
