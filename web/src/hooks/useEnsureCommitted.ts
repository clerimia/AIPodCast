import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { commitBlocker, toRequestOps } from '@/features/script-panel/staging'
import { episodeApi } from '@/lib/api/episode'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { Script } from '@/lib/api/types'
import { useStaging } from '@/stores/staging'

// 试听/合成前的自动提交（ADR-0003 Consequences，frontend-structure.md「合成前自动提交」）：
// 暂存非空先 POST /changes 再继续——合成只认库里已提交的文本，不自动提交就会
// 「听到的 ≠ 看到的」。提交结果与暂存条手动提交同构：清 store、直写 script 缓存、
// invalidatedLineIds 写入 invalidated 缓存（行上「需重新合成」据此点亮）。
// 返回 false = 暂存有阻断（空新增行）或提交失败，调用方应中止合成。
export function useEnsureCommitted(episodeId: string) {
  const queryClient = useQueryClient()

  return async (): Promise<boolean> => {
    const { buffers, clearAll } = useStaging.getState()
    const buf = buffers[episodeId]
    const ops = buf?.ops ?? []
    if (ops.length === 0) return true

    const blocker = commitBlocker(ops)
    if (blocker) {
      toast.error(`暂存改动未就绪：${blocker}`, { description: '处理完暂存改动再试听' })
      return false
    }

    try {
      const res = await episodeApi.applyChanges(episodeId, {
        ops: toRequestOps(ops),
        summary: buf?.summary || undefined,
      })
      clearAll(episodeId)
      queryClient.setQueryData(qk.script(episodeId), { lines: res.lines } satisfies Script)
      queryClient.setQueryData(qk.invalidated(episodeId), res.invalidatedLineIds)
      toast.info(`试听前已自动提交 ${ops.length} 处暂存改动`, {
        description: '试听合成的是已提交入库的稿子',
      })
      return true
    } catch (e) {
      toast.error(`自动提交暂存改动失败：${apiErrorMessage(e)}`)
      return false
    }
  }
}
