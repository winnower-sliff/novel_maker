import type { PendingConfirmInfo } from '../../../shared/types'

/** 确认等待超时：渲染端刷新/断连后无人应答时自动拒绝，防 run 在主进程死等（对齐 runRecords TTL） */
export const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000

interface PendingEntry extends PendingConfirmInfo {
  resolve: (allow: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 单个 run 的确认注册表：danger 工具等待渲染端应答。
 * always 语义：允许且记住该工具，本 run 内同名工具不再询问。
 */
export class ConfirmRegistry {
  private confirms = new Map<string, PendingEntry>()
  private alwaysAllowed = new Set<string>()

  /** 当前待确认的第一条（协议层单确认浮层假设）；无则 null */
  peekPending(): PendingConfirmInfo | null {
    const pending = [...this.confirms.values()][0]
    if (!pending) return null
    return {
      confirmId: pending.confirmId,
      toolName: pending.toolName,
      input: pending.input,
      dangerReason: pending.dangerReason
    }
  }

  /** 渲染端应答：allow 放行/拒绝；always 时把工具加入本 run 白名单。返回是否命中待确认项 */
  resolve(confirmId: string, allow: boolean, always: boolean): boolean {
    const pending = this.confirms.get(confirmId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.confirms.delete(confirmId)
    if (always && allow) this.alwaysAllowed.add(pending.toolName)
    pending.resolve(allow)
    return true
  }

  /** run 收尾/中断：全部待确认按拒绝收场，防悬挂 */
  cancelAll(): void {
    for (const pending of this.confirms.values()) {
      clearTimeout(pending.timer)
      pending.resolve(false)
    }
    this.confirms.clear()
  }

  isAlwaysAllowed(toolName: string): boolean {
    return this.alwaysAllowed.has(toolName)
  }

  /** 等待渲染端应答；超时自动拒绝（resolve false）兜底，真实应答/中断会清掉 timer */
  wait(info: PendingConfirmInfo): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.confirms.delete(info.confirmId)
        resolve(false)
      }, CONFIRM_TIMEOUT_MS)
      this.confirms.set(info.confirmId, { ...info, resolve, timer })
    })
  }
}
