// 全局事件桥的幂等安装器：同名桥只装一次（模块级登记，与组件存活无关）。
// 两端 App 连接就绪后调用各自的 ensureXxx()，重复调用是 no-op。
const installed = new Set<string>()

export function ensureBridge(name: string, install: () => void): void {
  if (installed.has(name) || typeof window === 'undefined') return
  installed.add(name)
  install()
}
