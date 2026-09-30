import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  shell,
  Tray
} from 'electron'
import { getDb } from './db'
import { registerIpc } from './ipc'
import { startServer, stopServer } from './server'
import { listSkills } from './skills'

if (process.env.NM_REMOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.NM_REMOTE_DEBUG_PORT)
}

let tray: Tray | null = null
let quitting = false
let mainWindow: BrowserWindow | null = null

function trayIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromPath(join(__dirname, '../../resources/tray.png'))
  return icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 })
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

function syncAutoLaunch(): void {
  app.setLoginItemSettings({ openAtLogin: true, path: process.execPath })
}

function createTray(): void {
  tray = new Tray(trayIcon())
  tray.setToolTip('Novel Maker')
  tray.on('double-click', showMainWindow)
  rebuildTrayMenu()
}

function rebuildTrayMenu(): void {
  if (!tray) return
  const auto = app.getLoginItemSettings().openAtLogin
  const menu: MenuItemConstructorOptions[] = [
    { label: '打开主窗口', click: showMainWindow },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: auto,
      click: (item): void => {
        app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath })
        rebuildTrayMenu()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: (): void => {
        quitting = true
        app.quit()
      }
    }
  ]
  tray.setContextMenu(Menu.buildFromTemplate(menu))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#09090b',
    title: 'Novel Maker',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => win.show())

  // 关窗 = 最小化到托盘：手机端访问依赖本机服务器长期存活
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)

  app.whenReady().then(() => {
    syncAutoLaunch()
    getDb()
    listSkills()
    registerIpc()
    void startServer()
    createWindow()
    createTray()

    app.on('activate', () => {
      showMainWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('will-quit', () => {
    void stopServer()
  })

  app.on('window-all-closed', () => {
    // 托盘常驻，窗口全关不退出
  })
}
