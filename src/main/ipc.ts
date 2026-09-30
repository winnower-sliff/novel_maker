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
    console.log('[IPC-DBG]', channel, String(handler).slice(0, 80))
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      console.log('[IPC-CALL]', channel, JSON.stringify(args).slice(0, 120))
      // handler 契约：第二参是契约元组（ArgsOf<C>），由调用方解构，不能 spread
      return (handler as (ctx: { sink: EventSink }, a: unknown[]) => unknown)(
        { sink: electronSink(e.sender) },
        args
      )
    })
  }

  ipcMain.handle('server:config', async (_e, patch: Parameters<typeof saveServerConfig>[0]) => {
    saveServerConfig(patch)
    await restartServer()
    return getServerStatus()
  })
}
