import { writeFile } from 'node:fs/promises'
import { dialog } from 'electron'
import { buildExport } from '../export'
import type { IpcOnlyHandlerTable } from './context'

/**
 * 仅 Electron IPC 可用（不暴露给局域网 HTTP）：
 * 服务器自身配置（server:config 留在 ipc.ts 内联注册）与本机导出对话框。
 */
export const ipcOnlyHandlers = {
  'exporter:run': async (_ctx, [opts]) => {
    const built = await buildExport(opts)
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出',
      defaultPath: built.filename,
      filters: [{ name: opts.format.toUpperCase(), extensions: [opts.format] }]
    })
    if (canceled || !filePath) throw new Error('已取消导出')
    await writeFile(filePath, built.data)
    return { path: filePath, words: built.words }
  }
} satisfies Partial<IpcOnlyHandlerTable>
