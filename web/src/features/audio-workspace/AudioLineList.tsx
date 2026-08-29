import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { PauseSpeedSelect, type PostLevelPatch } from '@/components/script/PauseSpeedSelect'
import { AudioLineRow } from '@/features/audio-workspace/AudioLineRow'
import { episodeApi } from '@/lib/api/episode'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { EpisodeDetail, PostRules, ScriptLine } from '@/lib/api/types'
import { useInvalidatedLineIds } from '@/hooks/useInvalidated'

// 音频工作区行级部分（M4，frontend-structure.md 的 AudioLineList）：集级默认档位 +
// 逐行试听/播放/覆盖下拉。整集合成按钮与 MasterPlayer 随 M5 落。
// 集级下拉 = PATCH /post-rules；行级 = PATCH /lines/:id/post（含「集级」回退 = null）。

export function AudioLineList({ episodeId, lines }: { episodeId: string; lines: ScriptLine[] }) {
  // 集级默认档位：与单集详情同缓存（['episode', ep]），PATCH 成功后直写 postRules
  const { data: postRules } = useQuery({
    queryKey: qk.episode(episodeId),
    queryFn: () => episodeApi.get(episodeId),
    enabled: episodeId !== '',
    select: (detail: EpisodeDetail) => detail.postRules,
  })
  const invalidated = useInvalidatedLineIds(episodeId)
  const queryClient = useQueryClient()

  const patchRules = async (patch: PostLevelPatch) => {
    // 集级形态不会发 null（无回退项）；类型上剔除保持 PATCH 体干净
    const body: Partial<PostRules> = {}
    if (patch.pause !== null && patch.pause !== undefined) body.pause = patch.pause
    if (patch.speed !== null && patch.speed !== undefined) body.speed = patch.speed
    if (Object.keys(body).length === 0) return
    try {
      const rules = await episodeApi.updatePostRules(episodeId, body)
      queryClient.setQueryData<EpisodeDetail>(qk.episode(episodeId), (old) =>
        old ? { ...old, postRules: rules } : old,
      )
    } catch (e) {
      toast.error(`集级默认保存失败：${apiErrorMessage(e)}`)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">音频工作区</span>
        <span className="text-xs text-muted-foreground">试听 = 单行合成；整集合成为 M5</span>
        {postRules && (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>集级默认</span>
            <PauseSpeedSelect value={postRules} onChange={(patch) => void patchRules(patch)} />
          </div>
        )}
      </div>

      {lines.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          还没有脚本行：先在上方脚本面板写台词（或让写稿大师写），这里逐行试听。
        </p>
      ) : (
        <div className="space-y-2">
          {lines.map((line) => (
            <AudioLineRow
              key={line.id}
              episodeId={episodeId}
              line={line}
              invalidated={invalidated.has(line.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
