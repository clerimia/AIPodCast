import { ArrowDown, ArrowUp, Loader2, Play, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { LineAudioPlayer } from '@/components/script/LineAudioPlayer'
import { SerialBadge } from '@/components/script/SerialBadge'
import { SpeakerSelect } from '@/components/script/SpeakerSelect'
import { useAutoGrow } from '@/hooks/use-auto-grow'
import { cn } from '@/lib/utils'
import type { ScriptLine, Speaker } from '@/lib/api/types'
import type { EditPatch } from '@/stores/staging'

// 脚本行（写稿视图，#30）：serial · 说话人 · 台词 · 指令 + 行内联试听。
// 行内编辑只改暂存、不改库（ADR-0003）；试听是写作时的校对动作——编排（自动提交、
// 缓存直写）在 ScriptLineList，行只收「播」相关的展示态。行内不放停顿/语速等
// 直写参数（ADR-0004 的后期参数只在后期视图），保持两套写语义不挤在同一行。
//
// 手感层：
// - 「待提交 / 需重新合成」用左侧色条表达（扫一列行的边缘就能挑出异常行，比逐行读
//   两个琥珀色徽标快得多）；
// - 试听键常驻右端、位置固定，编辑动作 hover 才浮出（占位不隐，避免行高跳动）；
// - 删除键前加分隔线并染红 hover，与「移动/插入」这类可逆动作区分开；
// - 台词随内容自增高，长句不再挤在两行里滚动。
export function ScriptLineRow({
  line,
  speakers,
  staged,
  isFirst,
  isLast,
  canPreview,
  needsResynth,
  previewing,
  error,
  audioUrl,
  playToken,
  onEdit,
  onPreview,
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
  /** 暂存新增行还没有库里的 line.id，不可试听 */
  canPreview: boolean
  /** !asset.has 或被提交改动作废（invalidatedLineIds） */
  needsResynth: boolean
  previewing: boolean
  error: string | null
  /** 该行是当前试听行时为素材 URL（播放器展开）；试听别行即收起 */
  audioUrl: string | null
  /** 每次 preview 成功自增：force 重生成是同 URL 覆盖，key 变化强制 audio 重取重播 */
  playToken: number
  onEdit: (patch: EditPatch) => void
  onPreview: (force: boolean) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onInsertAfter: () => void
}) {
  const textRef = useAutoGrow(line.text, 220)

  return (
    <div
      className={cn(
        'group relative rounded-lg border py-2 pr-2 pl-3 transition-colors',
        'focus-within:border-brand-border focus-within:bg-muted/30',
        staged && 'border-amber-500/40 bg-amber-500/5',
        needsResynth && !staged && 'border-amber-500/40',
      )}
    >
      {/* 左侧状态色条：暂存（琥珀实心）比单纯待合成更「未落定」 */}
      {(staged || needsResynth) && (
        <span
          aria-hidden
          className={cn(
            'absolute inset-y-2 left-0 w-0.5 rounded-full',
            staged ? 'bg-amber-500' : 'bg-amber-500/45',
          )}
        />
      )}

      <div className="flex items-center gap-1.5">
        <SerialBadge serial={line.serial} />
        <SpeakerSelect
          speakers={speakers}
          value={line.speakerId}
          onValueChange={(speakerId) => onEdit({ speakerId })}
        />
        {staged && (
          <Badge variant="outline" className="h-4 border-amber-500/40 px-1.5 text-[10px] text-amber-600">
            待提交
          </Badge>
        )}
        {needsResynth && (
          <Badge variant="outline" className="h-4 border-amber-500/40 px-1.5 text-[10px] text-amber-600">
            需重新合成
          </Badge>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {/* 编辑动作：hover/focus 才显形，但始终占位——行高与按钮位置不跳 */}
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`强制重新合成 ${line.serial}`}
              title="强制重新合成（force，重新调 TTS）"
              disabled={previewing || !canPreview}
              onClick={() => onPreview(true)}
            >
              <RotateCcw />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="上移"
              title="上移"
              disabled={isFirst}
              onClick={onMoveUp}
            >
              <ArrowUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="下移"
              title="下移"
              disabled={isLast}
              onClick={onMoveDown}
            >
              <ArrowDown />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="在下方插入一行"
              title="在下方插入一行"
              onClick={onInsertAfter}
            >
              <Plus />
            </Button>
            <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="删除本行"
              title="删除本行"
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          </div>

          {/* 试听常驻右端：位置固定，逐行试听时指针不用找 */}
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={`试听 ${line.serial}`}
            title={needsResynth ? '试听（合成该行素材并播放，秒级）' : '试听（命中素材直接播放）'}
            disabled={previewing || !canPreview}
            onClick={() => onPreview(false)}
          >
            {previewing ? <Loader2 className="animate-spin" /> : <Play />}
          </Button>
        </div>
      </div>

      <Textarea
        ref={textRef}
        value={line.text}
        placeholder="台词…"
        onChange={(e) => onEdit({ text: e.target.value })}
        rows={1}
        className="field-sizing-fixed min-h-8 resize-none overflow-y-auto border-none bg-transparent px-1 py-1 text-sm shadow-none focus-visible:border-none focus-visible:ring-0"
      />
      <Input
        value={line.instructions}
        placeholder="指令（怎么说）：语气 / 情感 / 风格…"
        onChange={(e) => onEdit({ instructions: e.target.value })}
        className="h-7 rounded-md border-none bg-transparent px-1 text-xs text-muted-foreground shadow-none focus-visible:border-none focus-visible:ring-0"
      />

      {audioUrl && <LineAudioPlayer src={audioUrl} playToken={playToken} />}
      {error && <p className="mt-1 px-1 text-xs text-destructive">试听失败：{error}</p>}
    </div>
  )
}
