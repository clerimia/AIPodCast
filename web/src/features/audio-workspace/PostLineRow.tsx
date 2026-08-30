import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { PauseSpeedSelect } from '@/components/script/PauseSpeedSelect'
import { SerialBadge } from '@/components/script/SerialBadge'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { episodeApi } from '@/lib/api/episode'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { LinePost, Script, ScriptLine } from '@/lib/api/types'

// 后期视图行（#30）：紧凑参数行——serial · 说话人 · 素材状态 · 行级停顿/语速覆盖。
// 不镜像全文（全文在写稿视图），不放播放器（停顿/语速是拼接层参数，单行试听
// 听不出来，听到效果要等 M5 master；播放动作在写稿视图的行内联试听）。
// 覆盖直 PATCH /lines/:id/post、不经门（ADR-0004），「集级」回退项选中即清覆盖。
// synthState（M5）：整集合成 tts 阶段的行级进度（进行中/已完成）。
export function PostLineRow({
  episodeId,
  line,
  invalidated,
  synthState,
}: {
  episodeId: string
  line: ScriptLine
  invalidated: boolean
  synthState?: 'done' | 'current' | null
}) {
  const queryClient = useQueryClient()

  const patchPost = async (patch: LinePost) => {
    try {
      const post = await episodeApi.updateLinePost(episodeId, line.id, patch)
      queryClient.setQueryData<Script>(qk.script(episodeId), (old) =>
        old ? { lines: old.lines.map((l) => (l.id === line.id ? { ...l, post } : l)) } : old,
      )
    } catch (e) {
      toast.error(`停顿/语速保存失败：${apiErrorMessage(e)}`)
    }
  }

  const status = invalidated ? (
    <Badge variant="outline" className="border-amber-500/50 text-xs text-amber-600">
      需重新合成
    </Badge>
  ) : line.asset.has ? (
    line.asset.durationMs !== null ? (
      <span className="text-xs text-muted-foreground">已合成 · {(line.asset.durationMs / 1000).toFixed(1)}s</span>
    ) : (
      <span className="text-xs text-muted-foreground">已合成</span>
    )
  ) : (
    <span className="text-xs text-muted-foreground">未合成</span>
  )

  return (
    <div className={cn('flex items-center gap-2 rounded-lg border px-3 py-1.5', invalidated && 'border-amber-500/50')}>
      <SerialBadge serial={line.serial} />
      <span className="shrink-0 text-xs text-muted-foreground">{line.speakerName}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{line.text}</span>
      {synthState === 'current' && (
        <span className="inline-flex items-center gap-1 text-xs text-primary">
          <Loader2 className="size-3 animate-spin" />
          合成中
        </span>
      )}
      {synthState === 'done' && <span className="text-xs text-emerald-600">✓</span>}
      {status}
      <PauseSpeedSelect withFollowDefault value={line.post} onChange={(patch) => void patchPost(patch)} />
    </div>
  )
}
