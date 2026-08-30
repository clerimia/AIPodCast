// 快捷键基建：组合键解析 / 匹配 / 展示格式化。
// 语法："mod+k"（mod = ⌘ on macOS、Ctrl  elsewhere）、"mod+shift+g"、"escape"、
// "mod+enter"。展示层把 mod 渲染成平台符号（⌘ / Ctrl），避免界面上写死 ⌘ 误导 Windows 用户。

/** 平台判定只在浏览器端有意义；SSR/测试环境退化为非 Mac（Ctrl） */
export const IS_MAC: boolean =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '')

interface ParsedCombo {
  mod: boolean
  shift: boolean
  alt: boolean
  /** 主键，小写；shift 组合键这里写基础键（如 "mod+shift+g" 的 "g"） */
  key: string
}

const MODIFIERS = new Set(['mod', 'shift', 'alt'])

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split('+').map((p) => p.trim())
  return {
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    key: parts.filter((p) => !MODIFIERS.has(p)).join('+'),
  }
}

/** 该组合是否带 mod（决定是否允许在输入框内触发） */
export function comboHasMod(combo: string): boolean {
  return parseCombo(combo).mod
}

export function matchesHotkey(event: KeyboardEvent, combo: string): boolean {
  const { mod, shift, alt, key } = parseCombo(combo)
  const modPressed = IS_MAC ? event.metaKey : event.ctrlKey
  // 反向修饰键（Mac 上的 Ctrl / 其它平台上的 ⌘）不算命中，避免 ⌘K 与 Ctrl+K 混淆
  const wrongMod = IS_MAC ? event.ctrlKey : event.metaKey
  if (mod !== modPressed) return false
  if (mod && wrongMod) return false
  if (shift !== event.shiftKey) return false
  if (alt !== event.altKey) return false
  return event.key.toLowerCase() === key
}

/** "mod+shift+g" → "⌘⇧G"（Mac）/ "Ctrl+Shift+G"（其它） */
export function formatHotkey(combo: string): string {
  const { mod, shift, alt, key } = parseCombo(combo)
  const parts: string[] = []
  if (mod) parts.push(IS_MAC ? '⌘' : 'Ctrl')
  if (alt) parts.push(IS_MAC ? '⌥' : 'Alt')
  if (shift) parts.push(IS_MAC ? '⇧' : 'Shift')
  parts.push(key === 'escape' ? 'Esc' : key === 'enter' ? '↵' : key.toUpperCase())
  return IS_MAC ? parts.join('') : parts.join('+')
}

/** 事件目标是否是可输入元素（裸键快捷键默认要避让） */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
