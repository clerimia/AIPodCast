import * as React from 'react'

import { cn } from '@/lib/utils'

// 键帽：快捷键提示的视觉载体。等宽小号 + 1px 边框，避免和 Badge 抢注意力。
function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded border border-border bg-muted/70 px-1.5 font-sans text-[10px] leading-none font-medium text-muted-foreground select-none',
        className,
      )}
      {...props}
    />
  )
}

/** 一组键帽（"⌘" + "K"），调用方传已经格式化好的片段 */
function KbdGroup({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {keys.map((k, i) => (
        <Kbd key={`${k}-${i}`}>{k}</Kbd>
      ))}
    </span>
  )
}

export { Kbd, KbdGroup }
