import { writeFile } from 'node:fs/promises'
import { dialog, ipcMain, type WebContents } from 'electron'
import type { ExportFormat, ServerConfigPatch, ServerStatus } from '../shared/types'
import type { EventSink } from './eventSink'
import { buildExport } from './export'
import { ipcOnlyHandlers, sharedHandlers } from './handlers'
import { restartServer } from './server'
import { saveServerConfig } from './settings'
import { getServerStatus } from './serverState'

function electronSink(win: WebContents): EventSink {
  return {
    send: (channel: string, requestId: string, ...args: unknown[]): void => {
      if (!win.isDestroyed()) win.send(channel, requestId, ...args)
    },
    isClosed: (): boolean => win.isDestroyed()
  }
}

export function registerIpc(): void {
  for (const [channel, handler] of Object.entries({ ...sharedHandlers, ...ipcOnlyHandlers })) {
    ipcMain.handle(channel, (e, ...args: unknown[]) =>
      handler({ sink: electronSink(e.sender) }, ...args)
    )
  }

  ipcMain.handle(
    'export:run',
    async (
      _e,
      opts: {
        projectId: string
        format: ExportFormat
        scope: 'all' | 'single'
        outlineId?: string
      }
    ): Promise<{ path: string; words: number }> => {
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
  )

  ipcMain.handle(
    'server:config',
    async (_e, patch: ServerConfigPatch): Promise<ServerStatus> => {
      saveServerConfig(patch)
      await restartServer()
      return getServerStatus()
    }
  )
}
