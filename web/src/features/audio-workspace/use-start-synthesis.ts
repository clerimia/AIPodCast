// 发起整集合成（#28）：从 PostView 抽出来给命令面板复用。
// 关键约束——轮询由 PostView 的 useSynthesisJob 独占，本 hook 只做「发起 + 把 jobId
// 写进 ['synthesis-job-id', ep] 缓存」，不订阅任务查询，避免多处挂载导致重复轮询
// （同一任务两个轮询者会各收场一次，toast 会出现两遍）。
// setJobId 直写 queryClient 而非经 useSynthesisJob：写的是同一个 key，接管方照样接上。
import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { episodeApi } from '@/lib/api/episode'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { ScriptLine } from '@/lib/api/types'
import { useEnsureCommitted } from '@/hooks/useEnsureCommitted'

/** 只读订阅「当前是否挂着合成任务」：只订阅 jobId 键（无 refetchInterval，不产生轮询）。
 * 终态收场时 jobId 被置回 null，因此 jobId 非空 ≈ 任务仍在跑。 */
export function useIsSynthesizing(episodeId: string): boolean {
  const { data } = useQuery({
    queryKey: qk.synthesisJobId(episodeId),
    queryFn: () => null as string | null,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  return data != null
}

export function useStartSynthesis(episodeId: string, lines: ScriptLine[]) {
  const queryClient = useQueryClient()
  const ensureCommitted = useEnsureCommitted(episodeId, '整集合成')

  return useCallback(async () => {
    if (lines.length === 0) return
    // 合成只认已入库的稿子：暂存非空先自动提交，否则「听到的 ≠ 看到的」
    if (!(await ensureCommitted())) return
    try {
      const { jobId } = await episodeApi.synthesize(episodeId)
      queryClient.setQueryData(qk.synthesisJobId(episodeId), jobId)
      toast.info('整集合成已开始', { description: '逐行 TTS → 拼接归一 → mp3，完成后产物就绪' })
    } catch (e) {
      toast.error(`发起合成失败：${apiErrorMessage(e)}`)
    }
  }, [episodeId, lines.length, ensureCommitted, queryClient])
}
