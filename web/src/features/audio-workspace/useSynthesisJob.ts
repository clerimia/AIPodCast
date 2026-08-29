// 整集合成任务轮询（#28）：jobId 存 ['synthesis-job-id', ep] Query 缓存（客户端状态，
// 同 invalidated 的用法——Zustand 只装暂存/写稿两份），写稿/后期视图切换不丢轮询。
// 活跃态 refetchInterval 2s、终态停（issue 定案）；轮询 404 = 任务行不存在 → 停轮询
// + invalidate artifact（synthesis-progress-and-cancel.md 轮询约定）。终态副作用唯一入口：
// - succeeded → 失效 artifact/script（素材回填 + 产物摘要就绪）、清 invalidated 标记、
//   清 jobId（产物面板随后由 artifact 缓存驱动）
// - failed/interrupted → 提示错误（error 详情在进度面板展示），清 jobId
// canceled 是 M6 两段式取消的终态，本轮同样收场（停轮询）。
import { useCallback, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { episodeApi } from '@/lib/api/episode'
import { ApiError } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { SynthesisJob } from '@/lib/api/types'
import { isTerminalJobStatus, jobRefetchInterval } from './synthesis'

function useSynthesisJobId(episodeId: string) {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: qk.synthesisJobId(episodeId),
    queryFn: () => null as string | null,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  const setJobId = useCallback(
    (newJobId: string | null) => queryClient.setQueryData(qk.synthesisJobId(episodeId), newJobId),
    [queryClient, episodeId],
  )
  return [data ?? null, setJobId] as const
}

export function useSynthesisJob(episodeId: string) {
  const [jobId, setJobId] = useSynthesisJobId(episodeId)
  const queryClient = useQueryClient()
  // 终态只收场一次：以 jobId+status 记账，同一 hook 实例先后两个任务互不误伤
  const settledRef = useRef<string | null>(null)

  const query = useQuery({
    queryKey: qk.synthesisJob(jobId ?? 'none'),
    queryFn: () => episodeApi.getSynthesisJob(jobId!),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const err = query.state.error
      if (err instanceof ApiError && err.status === 404) return false
      const status = query.state.data?.status
      return status ? jobRefetchInterval(status) : 2000
    },
  })

  const job: SynthesisJob | null = query.data ?? null

  // 终态收场
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
      toast.success('整集合成完成，可以试听 master 了')
    } else {
      const message = job.error?.message ?? '合成失败'
      if (job.status === 'interrupted') toast.info('合成中断', { description: message })
      else toast.error('整集合成失败', { description: message })
    }
    setJobId(null)
  }, [job, jobId, episodeId, queryClient, setJobId])

  // 轮询 404（任务行不存在，正常不应发生）→ 停轮询 + 产物缓存失效兜底 + 清 jobId
  useEffect(() => {
    const err = query.error
    if (!jobId || !(err instanceof ApiError) || err.status !== 404) return
    queryClient.invalidateQueries({ queryKey: qk.artifact(episodeId) })
    toast.error('合成任务不存在，已停止轮询')
    setJobId(null)
  }, [query.error, jobId, episodeId, queryClient, setJobId])

  return {
    jobId,
    job,
    isPolling: jobId !== null && (job === null || !isTerminalJobStatus(job.status)),
    setJobId,
  }
}
