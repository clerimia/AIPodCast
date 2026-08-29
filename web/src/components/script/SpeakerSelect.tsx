import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Speaker } from '@/lib/api/types'

// 说话人选择：文本侧行内编辑与音频侧共用；onChange 语义由消费方决定（文本侧=进暂存）。
export function SpeakerSelect({
  speakers,
  value,
  onValueChange,
  disabled,
  className,
}: {
  speakers: Speaker[]
  value: string
  onValueChange: (speakerId: string) => void
  disabled?: boolean
  className?: string
}) {
  return (
    <Select
      value={value || undefined}
      onValueChange={onValueChange}
      disabled={disabled || speakers.length === 0}
    >
      <SelectTrigger size="sm" className={className ?? 'w-28 shrink-0'}>
        <SelectValue placeholder={speakers.length === 0 ? '无说话人' : '说话人'} />
      </SelectTrigger>
      <SelectContent>
        {speakers.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
