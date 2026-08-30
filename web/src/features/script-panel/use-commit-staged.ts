// 提交暂存改动（ADR-0003）：从 StagingBar 抽出来，让命令面板 / ⌘Enter 也能触发。
// 与自动提交（useEnsureCommitted）是两条路径但同构：清 store、直写 script 缓存、
// invalidatedLineIds 写入 invalidated 缓存（行上「需重新合成」据此点亮）。
import { useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { apiErrorMessage } from '@/lib/api/http'
import { episodeApi } from '@/lib/api/episode'
import { qk } from '@/lib/api/keys'
import type { Script } from '@/lib/api/types'
import { useStaging } from '@/stores/staging'
import { commitBlocker, toRequestOps } from './staging'

export function useCommitStaged(episodeId: string) {
  const queryClient = useQueryClient()
  const ops = useStaging((s) => s.buffers[episodeId]?.ops)
  const summary = useStaging((s) => s.buffers[episodeId]?.summary)
  const clearAll = useStaging((s) => s.clearAll)

  const mutation = useMutation({
    mutationFn: () =>
      episodeApi.applyChanges(episodeId, {
        ops: toRequestOps(ops ?? []),
        summary: summary || undefined,
      }),
    onSuccess: (res) => {
      clearAll(episodeId)
      queryClient.setQueryData(qk.script(episodeId), { lines: res.lines } satisfies Script)
      queryClient.setQueryData(qk.invalidated(episodeId), res.invalidatedLineIds)
      toast.success('改动已提交', {
        description:
          res.invalidatedLineIds.length > 0
            ? `${res.invalidatedLineIds.length} 行的素材已作废，下次合成重新生成`
            : undefined,
      })
    },
    onError: (e) => toast.error(`提交失败：${apiErrorMessage(e)}`),
  })

  // clearAll 要稳定：调用方（EpisodePage 的命令列表）把它放进 useMemo 依赖里，
  // 每次渲染换新函数会让命令数组连带重算
  const discard = useCallback(() => clearAll(episodeId), [clearAll, episodeId])

  return {
    commit: mutation.mutate,
    isPending: mutation.isPending,
    ops: ops ?? [],
    blocker: commitBlocker(ops ?? []),
    clearAll: discard,
  }
}
