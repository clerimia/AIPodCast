import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AudioLines, Check, PenLine, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { PauseSpeedSelect, type PostLevelPatch } from '@/components/script/PauseSpeedSelect'
import { PostLineRow } from '@/features/audio-workspace/PostLineRow'
import { MasterPlayer } from '@/features/audio-workspace/MasterPlayer'
import { stageLabel, isActiveJobStatus } from '@/features/audio-workspace/synthesis'
import { useSynthesisJob } from '@/features/audio-workspace/useSynthesisJob'
import { useStartSynthesis } from '@/features/audio-workspace/use-start-synthesis'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { episodeApi } from '@/lib/api/episode'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { cn } from '@/lib/utils'
import type { EpisodeDetail, PostRules, ScriptLine, SynthesisJob, SynthesisStage } from '@/lib/api/types'
import { useArtifact } from '@/hooks/useArtifact'
import { useInvalidatedLineIds } from '@/hooks/useInvalidated'

// 后期视图（#30，原音频工作区下半区重构）：素材概览 + 集级默认档位 + 行级停顿/语速
// 覆盖 + 整集合成（M5 异步任务）+ MasterPlayer 产物播放。不镜像脚本行全文——那是
// 写稿视图的职责；这里只管拼接层参数、素材状态与产物。
//
// 手感层：合成是这里唯一的长任务，「点下去之后到底进行到哪一步」全靠一处进度条是
// 不够的——拆成阶段指示（合成语音 → 拼接归一 → 编码 → 校验），长任务才有过程感。
// 原先手搓的两颗 <button>（复制了一份 Button 的类名）换回 Button 组件。
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

  const { job, isPolling, interruptedJob, dismissInterrupted } = useSynthesisJob(episodeId)
  const { data: artifact } = useArtifact(episodeId)
  const startSynthesis = useStartSynthesis(episodeId, lines)

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
  const synthesizedCount = lines.length - needsResynthCount
  const synthRatio = lines.length > 0 ? (synthesizedCount / lines.length) * 100 : 0

  // 行级进度指示（tts 阶段）：done = 已合成行；current = 正在合成的行。
  // canceling 期间任务仍在收尾，行级状态照样亮（实现选择：收尾中的行进度对用户仍真实）。
  const synthStateOf = (lineId: string): 'done' | 'current' | null => {
    if (!job || !isActiveJobStatus(job.status) || job.status === 'pending' || job.stage !== 'tts') return null
    if (job.doneLineIds.includes(lineId)) return 'done'
    if (job.currentLine?.lineId === lineId) return 'current'
    return null
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4">
      {/* 素材概览：一行说清「多少行、合成到哪、还剩几行」，右侧挂集级默认档位 */}
      <div className="rounded-lg border px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="tabular-nums">{lines.length} 行</span>
          <span className="text-muted-foreground tabular-nums">
            已合成 <span className="font-medium text-foreground">{synthesizedCount}</span>
          </span>
          {needsResynthCount > 0 ? (
            <span className="text-amber-600 tabular-nums">待合成 {needsResynthCount}</span>
          ) : (
            <span className="flex items-center gap-1 text-emerald-600">
              <Check className="size-3.5" /> 素材齐了
            </span>
          )}
          {postRules && (
            <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>集级默认</span>
              <PauseSpeedSelect value={postRules} onChange={(patch) => void patchRules(patch)} />
            </div>
          )}
        </div>
        {lines.length > 0 && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                needsResynthCount === 0 ? 'bg-emerald-500' : 'bg-brand',
              )}
              style={{ width: `${synthRatio}%` }}
            />
          </div>
        )}
      </div>

      {lines.length === 0 ? (
        <EmptyState
          compact
          icon={PenLine}
          title="还没有脚本行"
          description="到「写稿」视图写台词（或让写稿大师写），这里调后期参数。"
        />
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
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">整集合成</h3>
          <span className="text-xs text-muted-foreground">
            逐行变速 → 按停顿拼接 → 响度归一（-16 LUFS）→ mp3
          </span>
          <Button
            className="ml-auto"
            size="sm"
            disabled={lines.length === 0 || isPolling}
            onClick={() => void startSynthesis()}
          >
            {isPolling ? (
              <>
                <span className="size-1.5 animate-breathe rounded-full bg-current" /> 合成中…
              </>
            ) : (
              <>
                <Sparkles /> 整集合成
              </>
            )}
          </Button>
        </div>

        {interruptedJob && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs">
            <span className="text-amber-600">上次合成被中断（进程重启）。</span>
            <button
              type="button"
              className="font-medium text-amber-600 underline underline-offset-2"
              onClick={() => void startSynthesis()}
            >
              一键重新合成
            </button>
            <button
              type="button"
              aria-label="关闭中断提示"
              className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
              onClick={dismissInterrupted}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {job && <SynthesisProgress job={job} lines={lines} />}
        {!job && !artifact && (
          <p className="text-xs text-muted-foreground">
            还没有产物。发起整集合成后，这里会出现进度与 master 播放器。
          </p>
        )}
      </div>

      {artifact && <MasterPlayer artifact={artifact} lines={lines} />}
    </div>
  )
}

/** 流水线的四个阶段，顺序照 docs 的后期编排（stage 为 null = 尚未开跑/排队中） */
const STAGES: { key: SynthesisStage; label: string }[] = [
  { key: 'tts', label: '合成语音' },
  { key: 'post', label: '拼接归一' },
  { key: 'encode', label: '编码 mp3' },
  { key: 'verify', label: '校验' },
]

// 任务进度面板：status / stage / doneLines / totalLines（#28/#22 验收要求可见）+ 终态
// error + 取消按钮（两段式：canceling 显示「取消中…」）。行级详情在上方行列表亮指示；
// 这里给整体进度条与文案。interrupted/failed 的任务快照会在下轮 startSynthesis 后被覆盖。
function SynthesisProgress({ job, lines }: { job: SynthesisJob; lines: ScriptLine[] }) {
  const [canceling, setCanceling] = useState(false)
  const serialOf = new Map(lines.map((l) => [l.id, l.serial]))
  const STATUS_LABEL: Record<string, string> = {
    pending: '排队中',
    running: '进行中',
    canceling: '取消中',
    succeeded: '完成',
    failed: '失败',
    canceled: '已取消',
    interrupted: '已中断',
  }

  const cancel = async () => {
    setCanceling(true)
    try {
      await episodeApi.cancelSynthesisJob(job.jobId)
      // 202/200 都以轮询推进到 canceled 终态；不在此处 toast（终态收场统一提示）
    } catch (e) {
      setCanceling(false)
      toast.error(`取消失败：${apiErrorMessage(e)}`)
    }
  }

  const percent = job.totalLines > 0 ? Math.round((job.doneLines / job.totalLines) * 100) : 0
  const active = isActiveJobStatus(job.status)
  const failed = job.status === 'failed'

  return (
    <div className="animate-rise space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{STATUS_LABEL[job.status]}</span>
        <span>{stageLabel(job.stage)}</span>
        {job.currentLine && <span>第 {job.currentLine.serial} 句…</span>}
        <span className="ml-auto tabular-nums">
          {job.doneLines}/{job.totalLines} 行
        </span>
        {active && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            disabled={job.status === 'canceling' || canceling}
            onClick={() => void cancel()}
          >
            {job.status === 'canceling' || canceling ? '取消中…' : '取消'}
          </Button>
        )}
      </div>

      {/* 阶段指示：只点亮「当前」这一档——任务没有回传各阶段的完成时刻，标早了就是假信息 */}
      {active && job.stage !== null && (
        <ol className="flex flex-wrap items-center gap-1.5">
          {STAGES.map((stage, i) => {
            const current = stage.key === job.stage
            return (
              <li key={stage.key} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] transition-colors',
                    current
                      ? 'bg-brand-soft font-medium text-brand'
                      : 'bg-muted text-muted-foreground/70',
                  )}
                >
                  {stage.label}
                </span>
                {i < STAGES.length - 1 && (
                  <span aria-hidden className="h-px w-2 bg-border" />
                )}
              </li>
            )
          })}
        </ol>
      )}

      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            failed ? 'bg-destructive' : 'bg-brand',
          )}
          style={{ width: `${!active ? percent : Math.max(percent, 4)}%` }}
        />
      </div>

      {job.error && (
        <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {job.error.code}
          {job.error.serial ? `（第 ${job.error.serial} 句）` : ''}：{job.error.message}
        </p>
      )}

      {(job.status === 'running' || job.status === 'canceling') && job.stage === 'tts' && (
        <p className="text-xs text-muted-foreground">
          已完成：{job.doneLineIds.map((id) => serialOf.get(id) ?? '·').join('、') || '—'}
        </p>
      )}

      {job.status === 'succeeded' && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-600">
          <AudioLines className="size-3.5" /> 产物已就绪，往下拖可以边听边对稿
        </p>
      )}
    </div>
  )
}
