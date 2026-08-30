// 命令面板（⌘K / Ctrl+K）：agent 类应用的标配入口——把散落在头部按钮、右键菜单里的
// 动作收进一个可搜索、可键盘走查的列表。不引 cmdk：命令量级只有十几条，自己实现
// 匹配与键盘导航比加一个依赖更轻，也更好控制分组与分组头。
// 命令由各页面自己组装（页面才知道当前单集/视图/暂存状态），本组件只负责展示与执行。
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useHotkey } from '@/hooks/use-hotkey'
import { cn } from '@/lib/utils'

export interface Command {
  id: string
  title: string
  /** 副标题：解释这条命令会做什么 */
  hint?: string
  /** 分组名，同名命令归到一组（如「视图」「合成」「导航」） */
  group: string
  icon?: LucideIcon
  /** 额外匹配词（中文别名 / 英文关键词），不展示 */
  keywords?: string
  /** 展示用快捷键，如 formatHotkey('mod+enter') */
  shortcut?: string
  disabled?: boolean
  /** 危险动作（撤销改动、删除）渲染成 destructive 色 */
  danger?: boolean
  run: () => void
}

/** 子序列模糊匹配：命中返回得分（越大越好），未命中 null。
 * 连续命中与词首命中有加成，让「hq」能匹配到「合成」的拼音别名、「写稿」能命中「写稿视图」。 */
function scoreMatch(haystack: string, needle: string): number | null {
  if (needle === '') return 0
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase().replace(/\s+/g, '')
  if (n === '') return 0

  let score = 0
  let hIndex = 0
  let streak = 0

  for (const char of n) {
    const found = h.indexOf(char, hIndex)
    if (found === -1) return null
    // 连续命中加成
    streak = found === hIndex ? streak + 1 : 0
    score += 1 + streak * 2
    // 词首/串首加成
    if (found === 0 || h[found - 1] === ' ' || h[found - 1] === '/') score += 3
    hIndex = found + 1
  }
  return score
}

function commandScore(command: Command, query: string): number | null {
  const candidates = [command.title, command.hint ?? '', command.keywords ?? '', command.group]
  let best: number | null = null
  for (const candidate of candidates) {
    const s = scoreMatch(candidate, query)
    if (s !== null) {
      // 标题命中权重最高
      const weighted = candidate === command.title ? s * 3 : s
      if (best === null || weighted > best) best = weighted
    }
  }
  return best
}

interface GroupedCommand {
  group: string
  /** 带 results 里的扁平下标：选中态要跨分组连续，不能在渲染期拿计数器自增 */
  items: { command: Command; index: number }[]
}

function groupCommands(commands: Command[]): GroupedCommand[] {
  const order: string[] = []
  const byGroup = new Map<string, GroupedCommand>()
  commands.forEach((command, index) => {
    if (!byGroup.has(command.group)) {
      byGroup.set(command.group, { group: command.group, items: [] })
      order.push(command.group)
    }
    byGroup.get(command.group)!.items.push({ command, index })
  })
  return order.map((group) => byGroup.get(group)!)
}

export function CommandPalette({
  commands,
  open,
  onOpenChange,
}: {
  commands: Command[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => {
    if (query.trim() === '') return commands
    return commands
      .map((command) => ({ command, score: commandScore(command, query.trim()) }))
      .filter((r): r is { command: Command; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.command)
  }, [commands, query])

  const groups = useMemo(() => groupCommands(results), [results])

  // 打开即重置搜索态：用渲染期对比上一值，不在 effect 里 setState（省一轮渲染）
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) {
      setQuery('')
      setActiveIndex(0)
    }
  }

  // 选中项夹在结果范围内：搜索后结果变短，越界的下标在这里收敛，不需要 effect 兜底
  const activeIndexClamped = results.length === 0 ? 0 : Math.min(activeIndex, results.length - 1)

  // 选中项滚进可视区（键盘走查时列表可能很长）
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndexClamped, groups])

  const runAt = (index: number) => {
    const command = results[index]
    if (!command || command.disabled) return
    onOpenChange(false)
    // 让 Dialog 关闭动画先走一帧，避免命令触发的 dialog/跳转被卸载打断
    requestAnimationFrame(() => command.run())
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(results.length === 0 ? 0 : (activeIndexClamped + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(results.length === 0 ? 0 : (activeIndexClamped - 1 + results.length) % results.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      runAt(activeIndexClamped)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] max-w-lg gap-0 overflow-hidden p-0 translate-y-0"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">命令面板</DialogTitle>

        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            placeholder="搜索命令…"
            aria-label="搜索命令"
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Kbd className="mr-0.5">Esc</Kbd>
        </div>

        <div ref={listRef} className="scrollbar-slim max-h-80 overflow-y-auto p-1.5">
          {results.length === 0 && (
            <p className="px-2.5 py-8 text-center text-sm text-muted-foreground">没有匹配的命令</p>
          )}

          {groups.map(({ group, items }) => (
            <div key={group} className="mb-1 last:mb-0">
              <p className="px-2.5 py-1 text-[11px] font-medium tracking-wide text-muted-foreground/70">
                {group}
              </p>
              {items.map(({ command, index }) => {
                const active = index === activeIndexClamped
                const Icon = command.icon
                return (
                  <button
                    key={command.id}
                    type="button"
                    data-active={active}
                    disabled={command.disabled}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => runAt(index)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                      active ? 'bg-accent text-accent-foreground' : 'text-foreground',
                      command.disabled && 'cursor-not-allowed opacity-40',
                    )}
                  >
                    {Icon && (
                      <Icon
                        className={cn(
                          'size-4 shrink-0',
                          command.danger ? 'text-destructive' : 'text-muted-foreground',
                        )}
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {command.title}
                      {command.hint && (
                        <span className="ml-2 text-xs text-muted-foreground">{command.hint}</span>
                      )}
                    </span>
                    {command.shortcut && <Kbd>{command.shortcut}</Kbd>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 border-t bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> 选择
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> 执行
          </span>
          <span className="ml-auto">共 {results.length} 条</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 注册 ⌘K / Ctrl+K 打开面板（允许在输入框内触发：写稿时手不离键盘） */
export function usePaletteHotkey(onOpen: () => void, enabled = true) {
  useHotkey('mod+k', (event) => {
    event.preventDefault()
    onOpen()
  }, { enabled })
}
