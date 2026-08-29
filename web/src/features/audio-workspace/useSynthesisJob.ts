// 整集合成任务轮询（#28）：jobId 来自 synthesis-job store（视图切换不丢），活跃态
// refetchInterval 2s、终态停（issue 定案）。终态副作用唯一入口在此：
// - succeeded → 失效 artifact/script（素材回填 + 产物摘要就绪）、清 invalidated 标记、
//   清 store jobId（产物面板随后由 artifact 缓存驱动）
// - failed/interrupted → 提示错误（error 详情在进度面板展示），清 store jobId
// canceled 是 M6 两段式取消的终态，本轮同样收场（停轮询）。
import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { episodeApi } from '@/lib/api/episode'
import { qk } from '@/lib/api/keys'
import type { SynthesisJob } from '@/lib/api/types'
import { useSynthesisJobStore } from '@/stores/synthesis-job'
import { isTerminalJobStatus, jobRefetchInterval } from './synthesis'

export function useSynthesisJob(episodeId: string) {
  const jobId = useSynthesisJobStore((s) => s.jobIds[episodeId] ?? null)
  const clearJobId = useSynthesisJobStore((s) => s.clearJobId)
  const queryClient = useQueryClient()
  // 终态只收场一次：以 jobId+status 记账，同一 hook 实例先后两个任务互不误伤
  const settledRef = useRef<string | null>(null)

  const query = useQuery({
    queryKey: qk.synthesisJob(jobId ?? 'none'),
    queryFn: () => episodeApi.getSynthesisJob(jobId!),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status ? jobRefetchInterval(status) : 2000
    },
  })

  const job: SynthesisJob | null = query.data ?? null

  useEffect(() => {
    if (!job || !jobId || !isTerminalJobStatus(job.status)) return
    const settled = `${jobId}:${job.status}`
    if (settledRef.current === settled) return
    settledRef.current = settled

    if (job.status === 'succeeded') {
      queryClient.invalidateQueries({ queryKey: qk.artifact(episodeId) })
      queryClient.invalidateQueries({ queryKey: qk.script(episodeId) })
      // 整包产物验证通过 = 全部行素材最新，清「需重新合成」标记（qk.invalidated 注释的约定）
      queryClient.setQueryData(qk.invalidated(episodeId), [])
      toast.success('整集合成完成，可以试听成片了')
    } else {
      const message = job.error?.message ?? '合成失败'
      if (job.status === 'interrupted') toast.info('合成中断', { description: message })
      else toast.error('整集合成失败', { description: message })
    }
    clearJobId(episodeId)
  }, [job, jobId, episodeId, queryClient, clearJobId])

  return { jobId, job, isPolling: jobId !== null && (job === null || !isTerminalJobStatus(job.status)) }
}
