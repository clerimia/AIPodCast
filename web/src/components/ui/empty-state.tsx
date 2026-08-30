import * as React from 'react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

// 统一空状态：此前每处都是一行灰字，既不解释「为什么是空的」也不说「下一步点哪」。
// 结构固定为 图标 → 标题 → 说明 → 行动，四个空状态（无工作间 / 无单集 / 无脚本行 /
// 无说话人）共用一套视觉，界面才像同一个应用。
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: LucideIcon
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
  /** 紧凑形态：用在面板内的次级空区（如后期视图「还没有脚本行」） */
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed text-center',
        compact ? 'gap-1.5 px-4 py-5' : 'gap-2.5 px-6 py-10',
        className,
      )}
    >
      {Icon && (
        <div
          className={cn(
            'flex items-center justify-center rounded-xl bg-brand-soft text-brand',
            compact ? 'size-8' : 'size-10',
          )}
        >
          <Icon className={cn(compact ? 'size-4' : 'size-5')} />
        </div>
      )}
      <p className={cn('font-medium', compact ? 'text-sm' : 'text-base')}>{title}</p>
      {description && (
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
