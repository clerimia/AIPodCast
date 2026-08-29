import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { PauseSpeedSelect, type PostLevelPatch } from '@/components/script/PauseSpeedSelect'
import { PostLineRow } from '@/features/audio-workspace/PostLineRow'
import { MasterPlayer } from '@/features/audio-workspace/MasterPlayer'
import { stageLabel } from '@/features/audio-workspace/synthesis'
import { useSynthesisJob } from '@/features/audio-workspace/useSynthesisJob'
import { episodeApi } from '@/lib/api/episode'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { EpisodeDetail, PostRules, ScriptLine, SynthesisJob } from '@/lib/api/types'
import { useArtifact } from '@/hooks/useArtifact'
import { useEnsureCommitted } from '@/hooks/useEnsureCommitted'
import { useInvalidatedLineIds } from '@/hooks/useInvalidated'
import { useSynthesisJobStore } from '@/stores/synthesis-job'

// 后期视图（#30，原音频工作区下半区重构）：素材概览 + 集级默认档位 + 行级停顿/语速
// 覆盖 + 整集合成（M5 异步任务）+ MasterPlayer 产物播放。不镜像脚本行全文——那是
// 写稿视图的职责；这里只管拼接层参数、素材状态与成片。
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

  const { job, isPolling } = useSynthesisJob(episodeId)
  const { data: artifact } = useArtifact(episodeId)
  const ensureCommitted = useEnsureCommitted(episodeId, '整集合成')
  const setJobId = useSynthesisJobStore((s) => s.setJobId)

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

  // 整集合成（#28）：先自动提交暂存（合成只认已入库的稿）→ POST /synthesize →
  // jobId 进 store 交给 useSynthesisJob 轮询。活跃任务期间按钮禁用（服务端 409 兜底）。
  const startSynthesis = async () => {
    if (lines.length === 0) return
    if (!(await ensureCommitted())) return
    try {
      const { jobId } = await episodeApi.synthesize(episodeId)
      setJobId(episodeId, jobId)
      toast.info('整集合成已开始', { description: '逐行 TTS → 拼接归一 → mp3，完成后自动出现成片' })
    } catch (e) {
      toast.error(`发起合成失败：${apiErrorMessage(e)}`)
    }
  }

  const needsResynthCount = lines.filter((l) => !l.asset.has || invalidated.has(l.id)).length
  // 行级进度指示（tts 阶段）：done = 已合成行；current = 正在合成的行
  const synthStateOf = (lineId: string): 'done' | 'current' | null => {
    if (!job || job.status !== 'running' || job.stage !== 'tts') return null
    if (job.doneLineIds.includes(lineId)) return 'done'
    if (job.currentLine?.lineId === lineId) return 'current'
    return null
  }

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
              synthState={synthStateOf(line.id)}
            />
          ))}
        </div>
      )}

      <div className="space-y-2 rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">整集合成</h3>
          <span className="text-xs text-muted-foreground">
            逐行变速 → 按停顿拼接 → 响度归一（-16 LUFS）→ mp3
          </span>
          <button
            type="button"
            className="ml-auto inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
            disabled={lines.length === 0 || isPolling}
            onClick={() => void startSynthesis()}
          >
            {isPolling ? '合成中…' : '整集合成'}
          </button>
        </div>
        {job && <SynthesisProgress job={job} lines={lines} />}
        {!job && !artifact && (
          <p className="text-xs text-muted-foreground">
            还没有成片。发起整集合成后，这里会出现进度与 master 播放器。
          </p>
        )}
      </div>

      {artifact && <MasterPlayer artifact={artifact} lines={lines} />}
    </div>
  )
}

// 任务进度面板：status / stage / doneLines / totalLines（#28 验收要求可见）+ 终态 error。
// 行级详情在上方行列表亮指示；这里给整体进度条与文案。interrupted/failed 的任务快照
// 会在下轮 startSynthesis 后被新 jobId 覆盖。
function SynthesisProgress({ job, lines }: { job: SynthesisJob; lines: ScriptLine[] }) {
  const serialOf = new Map(lines.map((l) => [l.id, l.serial]))
  const percent = job.totalLines > 0 ? Math.round((job.doneLines / job.totalLines) * 100) : 0
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {job.status === 'failed' ? '失败' : job.status === 'interrupted' ? '已中断' : '进行中'}
        </span>
        <span>{stageLabel(job.stage)}</span>
        {job.currentLine && <span>第 {job.currentLine.serial} 句…</span>}
        <span className="ml-auto tabular-nums">
          {job.doneLines}/{job.totalLines} 行
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${job.status === 'failed' || job.status === 'interrupted' ? percent : Math.max(percent, 4)}%` }}
        />
      </div>
      {job.error && (
        <p className="text-xs text-destructive">
          {job.error.code}
          {job.error.serial ? `（${job.error.serial}）` : ''}：{job.error.message}
        </p>
      )}
      {job.status === 'running' && job.stage === 'tts' && (
        <p className="text-xs text-muted-foreground">
          已完成：{job.doneLineIds.map((id) => serialOf.get(id) ?? '·').join('、') || '—'}
        </p>
      )}
    </div>
  )
}
