import type { WebContents } from 'electron'
import { ipcMain } from 'electron'
import type { EventSink } from './eventSink'
import { type Handler, ipcOnlyHandlers, sharedHandlers } from './handlers'
import { restartServer } from './server'
import { getServerStatus } from './serverState'
import { saveServerConfig } from './settings'

function electronSink(win: WebContents): EventSink {
  return {
    send: (channel, ...args) => {
      if (!win.isDestroyed()) win.send(channel, ...args)
    },
    isClosed: (): boolean => win.isDestroyed()
  }
}

export function registerIpc(): void {
  const tables = { ...sharedHandlers, ...ipcOnlyHandlers } as unknown as Record<string, Handler>
  for (const [channel, handler] of Object.entries(tables)) {
    ipcMain.handle(channel, (e, ...args: unknown[]) =>
      (handler as (ctx: { sink: EventSink }, ...a: unknown[]) => unknown)(
        { sink: electronSink(e.sender) },
        ...args
      )
    )
  }

  ipcMain.handle('server:config', async (e, patch: Parameters<typeof saveServerConfig>[0]) => {
    saveServerConfig(patch)
    await restartServer()
    return getServerStatus()
  })
}
