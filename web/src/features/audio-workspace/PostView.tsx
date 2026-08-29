import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { PauseSpeedSelect, type PostLevelPatch } from '@/components/script/PauseSpeedSelect'
import { PostLineRow } from '@/features/audio-workspace/PostLineRow'
import { episodeApi } from '@/lib/api/episode'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { EpisodeDetail, PostRules, ScriptLine } from '@/lib/api/types'
import { useInvalidatedLineIds } from '@/hooks/useInvalidated'

// 后期视图（#30，原音频工作区下半区重构）：素材概览 + 集级默认档位 + 行级停顿/语速
// 覆盖。整集合成与 MasterPlayer 随 M5 落（占位注明）。不镜像脚本行全文——那是写稿
// 视图的职责；这里只管拼接层参数与素材状态。
export function PostView({ episodeId, lines }: { episodeId: string; lines: ScriptLine[] }) {
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

  const needsResynthCount = lines.filter((l) => !l.asset.has || invalidated.has(l.id)).length

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {lines.length} 行 · {lines.length - needsResynthCount} 已合成
          {needsResynthCount > 0 && ` · ${needsResynthCount} 需重新合成`}
        </span>
        {postRules && (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>集级默认</span>
            <PauseSpeedSelect value={postRules} onChange={(patch) => void patchRules(patch)} />
          </div>
        )}
      </div>

      {lines.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          还没有脚本行：到「写稿」视图写台词（或让写稿大师写），这里调后期参数。
        </p>
      ) : (
        <div className="space-y-1.5">
          {lines.map((line) => (
            <PostLineRow
              key={line.id}
              episodeId={episodeId}
              line={line}
              invalidated={invalidated.has(line.id)}
            />
          ))}
        </div>
      )}

      {/* M5 占位：整集合成（异步任务）+ MasterPlayer（变速 → 拼接 → 归一 → mp3 后的产物播放 + 高亮） */}
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        整集合成与 master 播放器随 M5 落地：后处理管线（逐行变速 → 拼接 → 响度归一 → mp3），
        产物在此播放并按 transcript 高亮当前行。
      </p>
    </div>
  )
}
