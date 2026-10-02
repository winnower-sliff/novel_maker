import { useEffect, useRef } from 'react'

/**
 * Android 返回键处理器栈：后注册者在栈顶，返回键先消费栈顶。
 * handler 一旦入栈即「已消费」（含 confirm 取消等不动作分支），不会穿透到下层或退出应用。
 */
export type BackHandler = () => void

const stack: BackHandler[] = []

/** 注册返回处理器；返回注销函数（组件卸载时调用） */
export function registerBackHandler(handler: BackHandler): () => void {
  stack.push(handler)
  return () => {
    const i = stack.lastIndexOf(handler)
    if (i >= 0) stack.splice(i, 1)
  }
}

/** 返回键入口：栈非空则消费栈顶，返回 true 表示已消费 */
export function consumeBack(): boolean {
  if (stack.length === 0) return false
  stack[stack.length - 1]()
  return true
}

/** 挂载期注册返回处理器；active=false 时暂停注册（如弹层未打开） */
export function useBackHandler(handler: BackHandler, active = true): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => {
    if (!active) return
    return registerBackHandler(() => ref.current())
  }, [active])
}
