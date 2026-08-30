// 写稿运行 hook（frontend-structure.md「数据流约定」）：唯一允许直接摸 QueryClient
// 的地方——SSE script:changed → 防抖 300ms 失效 ['script']；done → 最终失效并恢复输入。
// 页面装载时拉 writer/history 回放历史气泡（change_set 等 display:false 服务端已过滤）。
// rAF 合帧（#29 验证项 1）：delta/thinking 事件入缓冲 + schedule rAF，每帧一次性按序
// apply（帧内同 kind 合并）；非流式增量事件（message:end/done/error/script:changed）
// 应用前先同步 flush，避免定稿后残留 delta 写进下一条气泡。
import { useCallback, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { writerApi } from '@/lib/api/writer'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { WriterSseEvent } from '@/lib/api/types'
import { applyWriterSseEvent, useWriterRunStore, writerRunActions, type RunState } from '@/stores/writer-run'

const SCRIPT_INVALIDATE_DEBOUNCE_MS = 300

type BufferedDelta = { kind: 'thinking' | 'text'; delta: string }

export function useWriterHistory(episodeId: string) {
  return useQuery({
    queryKey: qk.writerHistory(episodeId),
    queryFn: () => writerApi.getHistory(episodeId),
    enabled: episodeId !== '',
  })
}

export function useWriterRun(episodeId: string): {
  run: RunState | undefined
  send: (text: string, thinking: boolean) => Promise<void>
  stop: () => Promise<void>
} {
  const run = useWriterRunStore((s) => s.runs[episodeId])
  const queryClient = useQueryClient()
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bufRef = useRef<BufferedDelta[]>([])
  const rafRef = useRef<number | null>(null)

  // history 拉取成功 → 装载进运行态 store（只在成功时一次）
  const history = useWriterHistory(episodeId)
  useEffect(() => {
    if (history.data) writerRunActions.load(episodeId, history.data.messages)
  }, [episodeId, history.data])

  // 卸载/切单集：清防抖、在途流与未合帧缓冲
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      bufRef.current = []
      abortRef.current?.abort()
    },
    [episodeId],
  )

  /** 缓冲一次性按序写入 store（帧内同 kind 合并成一条增量，一次 setState 一段） */
  const flushBuffer = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    const buf = bufRef.current
    if (buf.length === 0) return
    bufRef.current = []
    for (const { kind, delta } of buf) {
      if (kind === 'thinking') applyWriterSseEvent(episodeId, { event: 'thinking', data: { delta } })
      else applyWriterSseEvent(episodeId, { event: 'delta', data: { delta } })
    }
  }, [episodeId])

  const scheduleDelta = useCallback(
    (kind: 'thinking' | 'text', delta: string) => {
      const buf = bufRef.current
      const last = buf[buf.length - 1]
      if (last && last.kind === kind) last.delta += delta
      else buf.push({ kind, delta })
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(() => flushBuffer())
    },
    [flushBuffer],
  )

  const invalidateScript = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['script', episodeId] })
  }, [queryClient, episodeId])

  const send = useCallback(
    async (text: string, thinking: boolean) => {
      if (run?.running) return
      writerRunActions.start(episodeId, text)
      const controller = new AbortController()
      abortRef.current = controller

      const onEvent = (event: WriterSseEvent) => {
        // 流式增量走 rAF 合帧；其余事件先同步 flush 再应用（定稿前清残留增量）
        if (event.event === 'thinking') {
          scheduleDelta('thinking', event.data.delta)
          return
        }
        if (event.event === 'delta') {
          scheduleDelta('text', event.data.delta)
          return
        }
        flushBuffer()
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
        await writerApi.sendMessage(episodeId, text, thinking, onEvent, controller.signal)
      } catch (err) {
        // 流层失败（网络/409 busy/5xx）：SSE error 事件已处理过运行态，这里兜底
        flushBuffer()
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
    [episodeId, run?.running, invalidateScript, flushBuffer, scheduleDelta],
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
