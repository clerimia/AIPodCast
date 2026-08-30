import * as React from 'react'

import { cn } from '@/lib/utils'

// 分段控件：视图切换这类「同一时刻只能有一个」的选择。比一组裸按钮更好辨认当前态，
// 也比 Tabs 轻（不需要面板挂载语义，两个视图本来就是常驻切换的）。
export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: React.ComponentType<{ className?: string }>
  /** 右上角计数角标（如「待合成 N 行」） */
  badge?: number
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  ariaLabel,
}: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  className?: string
  ariaLabel: string
}) {
  return (
    // 用 radiogroup 而非 tablist：两个视图没有对应的 tabpanel（本来就是同一块区域
    // 切换内容），tab 语义会缺 aria-controls，读屏反而更含糊
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5', className)}
    >
      {options.map((option) => {
        const active = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-all outline-none',
              'focus-visible:ring-2 focus-visible:ring-ring/60',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className="size-3.5" />}
            {option.label}
            {option.badge !== undefined && option.badge > 0 && (
              <span
                className={cn(
                  'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums',
                  active ? 'bg-amber-500/15 text-amber-600' : 'bg-foreground/10 text-muted-foreground',
                )}
              >
                {option.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export { Segmented }
