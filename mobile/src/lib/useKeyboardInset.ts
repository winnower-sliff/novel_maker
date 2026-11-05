import { Keyboard } from '@capacitor/keyboard'
import { useEffect, useState } from 'react'
import type { PluginListenerHandle } from '@capacitor/core'

/**
 * 软键盘避让 inset（px），供底部输入栏 paddingBottom。
 * 真机：@capacitor/keyboard 事件提供 keyboardHeight，减去系统已自行压缩的量
 * （adjustResize 生效时 innerHeight 缩小）——对「系统完全没避让 / 完全避让 /
 * 半避让」三种设备行为自适应；浏览器 preview：无插件事件，退回 visualViewport。
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    let baseInner = window.innerHeight
    let pluginHeight = 0

    const apply = () => {
      const shrunk = Math.max(0, baseInner - window.innerHeight)
      setInset(Math.max(0, pluginHeight - shrunk))
    }
    const show = (info: { keyboardHeight: number }) => {
      pluginHeight = info.keyboardHeight
      apply()
    }
    const hide = () => {
      pluginHeight = 0
      setInset(0)
      // 收起动画结束后刷新无键盘基线
      setTimeout(() => {
        baseInner = window.innerHeight
      }, 150)
    }

    const handles: Array<PluginListenerHandle> = []
    const track = (p: Promise<PluginListenerHandle>) => {
      void p.then(
        (h) => handles.push(h),
        () => {}
      )
    }
    track(Keyboard.addListener('keyboardWillShow', show))
    track(Keyboard.addListener('keyboardDidShow', show))
    track(Keyboard.addListener('keyboardWillHide', hide))
    track(Keyboard.addListener('keyboardDidHide', hide))

    const vv = window.visualViewport
    const vvUpdate = () => {
      if (!vv || pluginHeight > 0) return
      const v = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      if (v <= 8) baseInner = window.innerHeight
      setInset(v > 8 ? v : 0)
    }
    if (vv) {
      vvUpdate()
      vv.addEventListener('resize', vvUpdate)
      vv.addEventListener('scroll', vvUpdate)
    }

    return () => {
      for (const h of handles) void h.remove()
      if (vv) {
        vv.removeEventListener('resize', vvUpdate)
        vv.removeEventListener('scroll', vvUpdate)
      }
    }
  }, [])

  return inset
}
