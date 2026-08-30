// 整集合成任务轮询（#28）：jobId 存 ['synthesis-job-id', ep] Query 缓存（客户端状态，
// 同 invalidated 的用法——Zustand 只装暂存/写稿两份），写稿/后期视图切换不丢轮询。
// 活跃态 refetchInterval 2s、终态停（issue 定案）；轮询 404 = 任务行不存在 → 停轮询
// + invalidate artifact（synthesis-progress-and-cancel.md 轮询约定）。终态副作用唯一入口：
// - succeeded → 失效 artifact/script（素材回填 + 产物摘要就绪）、清 invalidated 标记、
//   清 jobId（产物面板随后由 artifact 缓存驱动）
// - canceled → 提示已合成 N 行素材已保留，失效 script（行素材状态对齐落盘现实，#22）
// - failed/interrupted → 提示错误（error 详情在进度面板展示），interrupted 补失效
//   artifact，清 jobId
// active-job（#22，M6）：无轮询目标时查 GET /episodes/:id/synthesis-job——活跃任务
// （pending/running/canceling）→ 接管 jobId 继续轮询（刷新页面不丢合成）；最近一次
// interrupted → 以 interruptedJob 返回（「上次合成被中断」横幅，新任务发起自然失效）；
// 404 → null 静默。
// 运行中同步（#29 验收）：doneLines 每有推进即失效 script——逐行素材落盘实时反映到
// 行徽标（后期「已合成 · X.Xs」、写稿「需重新合成」消退），终态另有最终失效。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { episodeApi } from '@/lib/api/episode'
import { ApiError } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { SynthesisJob } from '@/lib/api/types'
import { isActiveJobStatus, isTerminalJobStatus, jobRefetchInterval } from './synthesis'

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
  // 已失效处理的中断任务（横幅不再弹；新任务发起/手动关闭都会置上）
  const [dismissedInterruptedId, setDismissedInterruptedId] = useState<string | null>(null)

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

  // active-job 查询（#22）：只在无轮询目标时跑；404（无任务）吞成 null 不算错误
  const activeQuery = useQuery({
    queryKey: qk.activeSynthesisJob(episodeId),
    queryFn: async () => {
      try {
        return await episodeApi.getActiveSynthesisJob(episodeId)
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null
        throw err
      }
    },
    enabled: episodeId !== '' && jobId === null,
    refetchInterval: false,
  })
  const activeJob: SynthesisJob | null = activeQuery.data ?? null

  // 活跃任务 → 接管轮询（页面重载恢复；interrupted 只供横幅，不接管）
  useEffect(() => {
    if (jobId !== null || !activeJob) return
    if (isActiveJobStatus(activeJob.status)) {
      setJobId(activeJob.jobId)
    }
  }, [activeJob, jobId, setJobId])

  // 新任务发起（接管/手动开始）后，旧 interrupted 横幅自然失效（本会话不再弹）
  useEffect(() => {
    if (jobId !== null && activeJob?.status === 'interrupted') {
      setDismissedInterruptedId(activeJob.jobId)
    }
  }, [jobId, activeJob])

  const interruptedJob =
    jobId === null && activeJob?.status === 'interrupted' && activeJob.jobId !== dismissedInterruptedId
      ? activeJob
      : null

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
    } else if (job.status === 'canceled') {
      queryClient.invalidateQueries({ queryKey: qk.script(episodeId) })
      toast.info(`已取消：已合成 ${job.doneLines} 行素材已保留`, {
        description: '重新发起合成会命中已合成素材，几乎免费',
      })
    } else {
      const message = job.error?.message ?? '合成失败'
      if (job.status === 'interrupted') {
        queryClient.invalidateQueries({ queryKey: qk.artifact(episodeId) })
        toast.info('合成中断', { description: message })
      } else {
        toast.error('整集合成失败', { description: message })
      }
    }
    setJobId(null)
  }, [job, jobId, episodeId, queryClient, setJobId])

  // 逐行进度 → 行素材状态实时同步：tts 阶段每完成一行服务端即落盘该行素材，
  // 失效 script 让行徽标（未合成 → 已合成 · X.Xs）与「N 已合成」计数跟着任务走，
  // 不用等终态（doneLineIds 已含该行而徽标仍「未合成」的脱节）。仅在 doneLines
  // 变化时失效（轮询 2s 一次，进度没动不重拉）。
  const lastDoneRef = useRef(-1)
  useEffect(() => {
    if (!job || !isActiveJobStatus(job.status)) {
      lastDoneRef.current = -1
      return
    }
    if (job.doneLines === lastDoneRef.current) return
    lastDoneRef.current = job.doneLines
    queryClient.invalidateQueries({ queryKey: qk.script(episodeId) })
  }, [job, episodeId, queryClient])

  // 轮询 404（任务行不存在：进程重启丢失等异常路径）→ 停轮询 + 产物缓存失效兜底 + 清 jobId
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
    interruptedJob,
    dismissInterrupted: useCallback(
      () => activeJob && setDismissedInterruptedId(activeJob.jobId),
      [activeJob],
    ),
  }
}
