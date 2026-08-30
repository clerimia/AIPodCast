// 全局快捷键注册：window 级 keydown 监听。带 mod 的组合默认允许在输入框内触发
// （⌘K 在写稿框里也该能开命令面板），裸键默认避让输入框。
// 一个 hook 一份监听，组合键可传数组（同一动作多个绑定）。
import { useEffect, useRef } from 'react'
import { comboHasMod, isEditableTarget, matchesHotkey } from '@/lib/hotkeys'

export function useHotkey(
  combo: string | string[],
  handler: (event: KeyboardEvent) => void,
  options: { enabled?: boolean; allowInInput?: boolean } = {},
) {
  const { enabled = true, allowInInput } = options
  // handler 每次渲染都是新函数；放进 ref 避免监听反复解绑重绑
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  const combos = Array.isArray(combo) ? combo : [combo]

  useEffect(() => {
    if (!enabled || combos.length === 0) return

    const onKeyDown = (event: KeyboardEvent) => {
      const hit = combos.some((c) => matchesHotkey(event, c))
      if (!hit) return
      const allowed = allowInInput ?? combos.some(comboHasMod)
      if (!allowed && isEditableTarget(event.target)) return
      handlerRef.current(event)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, allowInInput, combos.join('|')])
}
