import { useEffect, useState } from 'react'

/**
 * 软键盘 inset 兜底。
 * Capacitor Keyboard resize=native 生效时 WebView 被压缩，本值恒 0；
 * 在 edge-to-edge 等场景 native resize 失效时，visualViewport 仍会收缩，
 * 此时返回键盘高度（px），供输入栏 paddingBottom 顶出键盘区。
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const v = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      setInset(v > 8 ? v : 0)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
  return inset
}
