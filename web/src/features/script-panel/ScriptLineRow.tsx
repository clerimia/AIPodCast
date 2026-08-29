import { useEffect, useRef } from 'react'
import { ArrowDown, ArrowUp, Loader2, Play, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SerialBadge } from '@/components/script/SerialBadge'
import { SpeakerSelect } from '@/components/script/SpeakerSelect'
import { cn } from '@/lib/utils'
import type { ScriptLine, Speaker } from '@/lib/api/types'
import type { EditPatch } from '@/stores/staging'

// 脚本行（写稿视图，#30）：serial · 说话人 · 台词 · 指令 + 行内联试听。
// 行内编辑只改暂存、不改库（ADR-0003）；试听是写作时的校对动作——编排（自动提交、
// 缓存直写）在 ScriptLineList，行只收「播」相关的展示态。行内不放停顿/语速等
// 直写参数（ADR-0004 的后期参数只在后期视图），保持两套写语义不挤在同一行。
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
  const audioRef = useRef<HTMLAudioElement>(null)

  // 试听成功即自动播放：用户点 ▶ 后的程序化播放属合法手势；被策略拒绝时行上仍有 controls 可手动播
  useEffect(() => {
    const el = audioRef.current
    if (playToken === 0 || !el) return
    el.load()
    void el.play().catch(() => {})
  }, [playToken, audioUrl])

  return (
    <div
      className={cn(
        'group rounded-lg border px-3 py-2 transition-colors',
        staged && 'border-amber-500/50 bg-amber-500/5',
        needsResynth && 'border-amber-500/50',
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
        {needsResynth && (
          <Badge variant="outline" className="border-amber-500/50 text-xs text-amber-600">
            需重新合成
          </Badge>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={`试听 ${line.serial}`}
            title={
              needsResynth
                ? '试听（合成该行素材并播放，秒级）'
                : '试听（命中素材直接播放）'
            }
            disabled={previewing || !canPreview}
            onClick={() => onPreview(false)}
          >
            {previewing ? <Loader2 className="animate-spin" /> : <Play />}
          </Button>
          <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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
      {audioUrl && (
        <audio
          key={`${audioUrl}-${playToken}`}
          ref={audioRef}
          controls
          preload="none"
          src={audioUrl}
          className="mt-1.5 h-8 w-full"
        />
      )}
      {error && <p className="mt-1 px-1 text-xs text-destructive">试听失败：{error}</p>}
    </div>
  )
}
