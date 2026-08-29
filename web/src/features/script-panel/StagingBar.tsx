import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { apiErrorMessage } from '@/lib/api/http'
import { episodeApi } from '@/lib/api/episode'
import { qk } from '@/lib/api/keys'
import type { Script } from '@/lib/api/types'
import { useStaging } from '@/stores/staging'
import { commitBlocker, toRequestOps } from './staging'

// 暂存条（ADR-0003）：N 处改动待提交 · 撤销全部 / 提交改动。
// 提交 = POST /changes：成功后清空 store、用响应的新脚本直写缓存、invalidatedLineIds
// 写入 restale 缓存（音频区据此亮「需重新合成」，M4 消费；整集合成成功后清除）。
export function StagingBar({ episodeId }: { episodeId: string }) {
  const queryClient = useQueryClient()
  const ops = useStaging((s) => s.buffers[episodeId]?.ops)
  const summary = useStaging((s) => s.buffers[episodeId]?.summary)
  const clearAll = useStaging((s) => s.clearAll)

  const blocker = commitBlocker(ops ?? [])

  const commit = useMutation({
    mutationFn: () =>
      episodeApi.applyChanges(episodeId, {
        ops: toRequestOps(ops ?? []),
        summary: summary || undefined,
      }),
    onSuccess: (res) => {
      clearAll(episodeId)
      queryClient.setQueryData(qk.script(episodeId), { lines: res.lines } satisfies Script)
      queryClient.setQueryData(qk.restale(episodeId), res.invalidatedLineIds)
      toast.success('改动已提交', {
        description:
          res.invalidatedLineIds.length > 0
            ? `${res.invalidatedLineIds.length} 行的素材已作废，下次合成重新生成`
            : undefined,
      })
    },
    onError: (e) => toast.error(`提交失败：${apiErrorMessage(e)}`),
  })

  if (!ops || ops.length === 0) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-8 z-50 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-background/95 py-1.5 pr-1.5 pl-4 shadow-lg backdrop-blur">
        <span className="text-sm whitespace-nowrap">
          <span className="font-medium">{ops.length}</span> 处改动待提交
        </span>
        <Button variant="ghost" size="sm" disabled={commit.isPending} onClick={() => clearAll(episodeId)}>
          撤销全部
        </Button>
        <Button
          size="sm"
          disabled={commit.isPending || blocker !== null}
          title={blocker ?? undefined}
          onClick={() => commit.mutate()}
        >
          {commit.isPending ? '提交中…' : '提交改动'}
        </Button>
      </div>
    </div>
  )
}
