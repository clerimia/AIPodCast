// 写稿运行 hook（frontend-structure.md「数据流约定」）：唯一允许直接摸 QueryClient
// 的地方——SSE script:changed → 防抖 300ms 失效 ['script']；done → 最终失效并恢复输入。
// 页面装载时拉 writer/history 回放历史气泡（change_set 等 display:false 服务端已过滤）。
import { useCallback, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { writerApi } from '@/lib/api/writer'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { WriterSseEvent } from '@/lib/api/types'
import { applyWriterSseEvent, useWriterRunStore, writerRunActions, type RunState } from '@/stores/writer-run'

const SCRIPT_INVALIDATE_DEBOUNCE_MS = 300

export function useWriterHistory(episodeId: string) {
  return useQuery({
    queryKey: qk.writerHistory(episodeId),
    queryFn: () => writerApi.getHistory(episodeId),
    enabled: episodeId !== '',
  })
}

export function useWriterRun(episodeId: string): {
  run: RunState | undefined
  send: (text: string) => Promise<void>
  stop: () => Promise<void>
} {
  const run = useWriterRunStore((s) => s.runs[episodeId])
  const queryClient = useQueryClient()
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // history 拉取成功 → 装载进运行态 store（只在成功时一次）
  const history = useWriterHistory(episodeId)
  useEffect(() => {
    if (history.data) writerRunActions.load(episodeId, history.data.messages)
  }, [episodeId, history.data])

  // 卸载/切单集：清防抖与在途流
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      abortRef.current?.abort()
    },
    [episodeId],
  )

  const invalidateScript = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['script', episodeId] })
  }, [queryClient, episodeId])

  const send = useCallback(
    async (text: string) => {
      if (run?.running) return
      writerRunActions.start(episodeId, text)
      const controller = new AbortController()
      abortRef.current = controller

      const onEvent = (event: WriterSseEvent) => {
        applyWriterSseEvent(episodeId, event)
        if (event.event === 'script:changed') {
          // 防抖 300ms：一轮多工具只重拉一两次（frontend-structure.md）
          if (debounceRef.current) clearTimeout(debounceRef.current)
          debounceRef.current = setTimeout(invalidateScript, SCRIPT_INVALIDATE_DEBOUNCE_MS)
        }
        if (event.event === 'done') {
          invalidateScript()
        }
        if (event.event === 'error') {
          toast.error(`写稿大师出错：${event.data.message}`)
        }
      }

      try {
        await writerApi.sendMessage(episodeId, text, onEvent, controller.signal)
      } catch (err) {
        // 流层失败（网络/409 busy/5xx）：SSE error 事件已处理过运行态，这里兜底
        if ((err as Error)?.name === 'AbortError') {
          writerRunActions.finish(episodeId)
        } else {
          applyWriterSseEvent(episodeId, { event: 'error', data: { message: apiErrorMessage(err) } })
          toast.error(`写稿大师出错：${apiErrorMessage(err)}`)
        }
      } finally {
        abortRef.current = null
      }
    },
    [episodeId, run?.running, invalidateScript],
  )

  const stop = useCallback(async () => {
    try {
      await writerApi.abort(episodeId)
      // 服务端 abort 后 SSE 以 done 收尾；本地无需立即 finish（等流结束保持一致性）
    } catch (err) {
      toast.error(`停止失败：${apiErrorMessage(err)}`)
    }
  }, [episodeId])

  return { run, send, stop }
}
