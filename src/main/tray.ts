import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Action, ClickEvent, Menu, MenuItem } from 'systray'
import SysTrayModule from 'systray'
import { autostartEnabled, autostartSupported, setAutostart } from './autostart.js'
import { setPassword } from './config.js'
import { connectHost, openWithSystem, randomPassword, writeConnectQr } from './connect.js'
import { dataDir, resourcesDir } from './paths.js'
import { restartServer, stopServer } from './server.js'
import { getServerStatus } from './serverState.js'

const MENU_STATUS = 0
const MENU_SEP1 = 1
const MENU_QR = 2
const MENU_RESET_PASSWORD = 3
const MENU_AUTOSTART = 4
const MENU_SEP2 = 5
const MENU_RESTART = 6
const MENU_EXIT = 7

// systray 1.0.5 是 TS2.8 时代编译的 CJS 包（exports.default 间接赋值，
// cjs-module-lexer 不识别），ESM default import 拿到的是 module.exports 对象，
// 真正的构造函数在 .default 上。实测：import('systray').default.default === function。
// 类型侧 TS7/NodeNext 也无法把 default 当类用，故手写窄接口 + 运行时解包。
interface SysTrayInstance {
  onReady(listener: () => void): SysTrayInstance
  onClick(listener: (action: ClickEvent) => void): SysTrayInstance
  sendAction(action: Action): SysTrayInstance
  kill(exitNode?: boolean): void
  readonly killed: boolean
}
type SysTrayCtor = new (conf: { menu: Menu; debug?: boolean }) => SysTrayInstance
const SysTray = (SysTrayModule as unknown as { default: SysTrayCtor }).default

let tray: SysTrayInstance | null = null
let autostartOn = false

function statusTitle(): string {
  const { running } = getServerStatus()
  const { host, port } = connectHost()
  return running ? `运行中 · ${host}:${port}` : `未运行（端口 ${port}）`
}

function separator(tooltip = ''): MenuItem {
  return { title: '-', tooltip, checked: false, enabled: false }
}

function buildMenu(): MenuItem[] {
  return [
    { title: statusTitle(), tooltip: 'novel-maker 服务状态', checked: false, enabled: false },
    separator(),
    { title: '显示连接二维码', tooltip: '手机扫码连接本服务', checked: false, enabled: true },
    {
      title: '重置访问密码',
      tooltip: '生成新密码并吊销所有已连接设备',
      checked: false,
      enabled: true
    },
    {
      title: autostartSupported() ? '开机自启' : '开机自启（正式部署后可用）',
      tooltip: '开机自动启动服务',
      checked: autostartOn,
      enabled: autostartSupported()
    },
    separator(),
    { title: '重启服务', tooltip: '重启 HTTP 服务', checked: false, enabled: true },
    { title: '退出', tooltip: '停止服务并退出', checked: false, enabled: true }
  ]
}

function updateItem(seqId: number, patch: Partial<MenuItem>): void {
  const base = buildMenu()[seqId]
  if (!base || !tray) return
  const item: MenuItem = {
    title: patch.title ?? base.title,
    tooltip: patch.tooltip ?? base.tooltip,
    checked: patch.checked ?? base.checked,
    enabled: patch.enabled ?? base.enabled
  }
  tray.sendAction({ type: 'update-item', item, seq_id: seqId })
}

export function refreshTray(): void {
  updateItem(MENU_STATUS, { title: statusTitle() })
  updateItem(MENU_AUTOSTART, { checked: autostartOn })
}

async function handleResetPassword(): Promise<void> {
  const password = randomPassword()
  setPassword(password)
  const file = join(dataDir(), 'new-password.txt')
  writeFileSync(
    file,
    [
      'novel-maker 访问密码已重置',
      '',
      `新密码：${password}`,
      '',
      '所有已连接的手机需要重新输入此密码登录。',
      '地址与密码也可在首次生成的 first-run.txt 中找到。',
      ''
    ].join('\n'),
    'utf8'
  )
  openWithSystem(file)
}

async function handleRestart(): Promise<void> {
  try {
    await restartServer()
  } catch (err) {
    console.error('[tray] 重启服务失败:', err)
  }
  refreshTray()
}

export async function startTray(): Promise<void> {
  if (tray) return
  autostartOn = autostartSupported() && (await autostartEnabled())
  const icon = readFileSync(join(resourcesDir(), 'tray.png')).toString('base64')
  tray = new SysTray({
    menu: { icon, title: 'novel-maker', tooltip: 'novel-maker 写作服务', items: buildMenu() }
  })
  tray.onClick(async (action: ClickEvent) => {
    try {
      switch (action.seq_id) {
        case MENU_QR:
          await writeConnectQr()
          openWithSystem(join(dataDir(), 'connect-qr.png'))
          break
        case MENU_RESET_PASSWORD:
          await handleResetPassword()
          break
        case MENU_AUTOSTART:
          await setAutostart(!autostartOn)
          autostartOn = !autostartOn
          refreshTray()
          break
        case MENU_RESTART:
          await handleRestart()
          break
        case MENU_EXIT:
          await shutdown()
          break
        default:
          break
      }
    } catch (err) {
      console.error('[tray] 菜单操作失败:', err)
    }
  })
}

export async function shutdown(): Promise<void> {
  try {
    await stopServer()
  } catch {
    // 退出路径尽力而为
  }
  try {
    tray?.kill()
  } catch {
    // 同上
  }
  process.exit(0)
}
