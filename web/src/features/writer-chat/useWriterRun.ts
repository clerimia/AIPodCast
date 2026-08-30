// 写稿运行 hook：纯 React 适配层——订阅运行态 store + 装载历史气泡回放
// （change_set 等 display:false 服务端已过滤）。流的生命周期与发送/中止都在
// stores/writer-run.ts（模块级，与组件解耦：导航离开编辑页流不断，回来即续上）；
// 生成中跳过 history 装载：返回页面时拿到的快照会覆盖 live 状态。
import { useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { writerApi } from '@/lib/api/writer'
import { qk } from '@/lib/api/keys'
import { useWriterRunStore, writerRunActions, type RunState } from '@/stores/writer-run'

export function useWriterHistory(episodeId: string) {
  return useQuery({
    queryKey: qk.writerHistory(episodeId),
    queryFn: () => writerApi.getHistory(episodeId),
    enabled: episodeId !== '',
  })
}

export function useWriterRun(episodeId: string): {
  run: RunState | undefined
  send: (text: string, thinking: boolean) => void
  stop: () => Promise<void>
} {
  const run = useWriterRunStore((s) => s.runs[episodeId])

  // history 拉取成功 → 装载进运行态 store（只在成功时一次）。
  // 生成中跳过：返回页面时拿到的是请求发出时刻的快照，会覆盖控制器的 live 状态
  const history = useWriterHistory(episodeId)
  useEffect(() => {
    if (history.data && !useWriterRunStore.getState().runs[episodeId]?.running) {
      writerRunActions.load(episodeId, history.data.messages)
    }
  }, [episodeId, history.data])

  const send = useCallback(
    (text: string, thinking: boolean) => writerRunActions.send(episodeId, text, thinking),
    [episodeId],
  )
  const stop = useCallback(() => writerRunActions.stop(episodeId), [episodeId])

  return { run, send, stop }
}
