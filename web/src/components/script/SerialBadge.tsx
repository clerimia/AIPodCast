import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// 行号徽标（L001…）：既是序列号也是顺序；上下两半共用。
export function SerialBadge({ serial, className }: { serial: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn('shrink-0 font-mono text-xs tabular-nums text-muted-foreground', className)}
    >
      {serial}
    </Badge>
  )
}
