import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SerialBadge } from '@/components/script/SerialBadge'
import { SpeakerSelect } from '@/components/script/SpeakerSelect'
import { cn } from '@/lib/utils'
import type { ScriptLine, Speaker } from '@/lib/api/types'
import type { EditPatch } from '@/stores/staging'

// 脚本行（文本投影）：serial · 说话人 · 台词 · 指令。
// 行内编辑只改暂存、不改库（ADR-0003）——每次击键 stageEdit，store 并进同一 op。
export function ScriptLineRow({
  line,
  speakers,
  staged,
  isFirst,
  isLast,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
  onInsertAfter,
}: {
  line: ScriptLine
  speakers: Speaker[]
  staged: boolean
  isFirst: boolean
  isLast: boolean
  onEdit: (patch: EditPatch) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onInsertAfter: () => void
}) {
  return (
    <div
      className={cn(
        'group rounded-lg border px-3 py-2 transition-colors',
        staged && 'border-amber-500/50 bg-amber-500/5',
      )}
    >
      <div className="flex items-center gap-2">
        <SerialBadge serial={line.serial} />
        <SpeakerSelect
          speakers={speakers}
          value={line.speakerId}
          onValueChange={(speakerId) => onEdit({ speakerId })}
        />
        {staged && (
          <Badge variant="outline" className="border-amber-500/50 text-xs text-amber-600">
            待提交
          </Badge>
        )}
        <div className="ml-auto flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="上移"
            disabled={isFirst}
            onClick={onMoveUp}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="下移"
            disabled={isLast}
            onClick={onMoveDown}
          >
            <ArrowDown />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="在下方插入一行"
            onClick={onInsertAfter}
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="删除本行"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <Textarea
        value={line.text}
        placeholder="台词…"
        onChange={(e) => onEdit({ text: e.target.value })}
        className="min-h-9 resize-none border-none bg-transparent px-1 py-1 shadow-none focus-visible:border-none focus-visible:ring-0 md:text-sm"
      />
      <Input
        value={line.instructions}
        placeholder="指令（怎么说）：语气 / 情感 / 风格…"
        onChange={(e) => onEdit({ instructions: e.target.value })}
        className="h-7 rounded-md border-none bg-transparent px-1 text-xs text-muted-foreground shadow-none focus-visible:border-none focus-visible:ring-0"
      />
    </div>
  )
}
