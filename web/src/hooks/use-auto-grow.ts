import { useEffect, useRef } from 'react'

// textarea 自增高：随内容长高，到 maxHeight 为止转内部滚动。
// 不用 Tailwind 的 field-sizing-content——Safari 支持还不稳，手动算 scrollHeight 行为一致。
export function useAutoGrow<T extends HTMLTextAreaElement>(value: string, maxHeight = 200) {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [value, maxHeight])

  return ref
}
