// 写稿运行态（frontend-structure.md stores/writer-run.ts）：流式气泡 + 运行状态 +
// 工具状态条，按 episodeId 区分。SSE 事件由 useWriterRun 写入；组件只读。
import { create } from 'zustand'
import type { WriterHistoryEntry, WriterSseEvent } from '@/lib/api/types'

export interface ToolStatus {
  toolCallId: string
  tool: string
  /** running | ok | error */
  state: 'running' | 'ok' | 'error'
  summary: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  toolCalls?: WriterHistoryEntry['toolCalls']
}

interface WriterRunState {
  /** null = 空闲 */
  runs: Record<string, RunState>
}

export interface RunState {
  /** idle 前的历史气泡 + 本轮已出现的气泡 */
  messages: ChatMessage[]
  /** 当前流式中的 assistant 气泡（done 时定稿进 messages 并清空） */
  streamingText: string
  /** run:start → done/error 之间 */
  running: boolean
  /** 工具状态条（toolCallId → 状态） */
  tools: ToolStatus[]
  /** 本轮错误（error 事件或流层失败） */
  error: string | null
}

const emptyRun = (history: ChatMessage[] = []): RunState => ({
  messages: history,
  streamingText: '',
  running: false,
  tools: [],
  error: null,
})

function withRun(state: WriterRunState, episodeId: string, run: RunState): WriterRunState {
  return { runs: { ...state.runs, [episodeId]: run } }
}

export const useWriterRunStore = create<WriterRunState>(() => ({ runs: {} }))

// ---- actions（useWriterRun 内部消费，组件不直接调）----

export const writerRunActions = {
  /** 进入页面/重置：装载历史气泡 */
  load(episodeId: string, history: ChatMessage[]) {
    useWriterRunStore.setState((state) => withRun(state, episodeId, emptyRun(history)))
  },

  /** 开始一轮 run：先渲染用户气泡 */
  start(episodeId: string, text: string) {
    useWriterRunStore.setState((state) => {
      const run = state.runs[episodeId] ?? emptyRun()
      return withRun(state, episodeId, {
        ...run,
        messages: [...run.messages, { role: 'user', text }],
        streamingText: '',
        running: true,
        tools: [],
        error: null,
      })
    })
  },

  /** 收尾：残留 streamingText 兜底落气泡（message:end 已逐条落气泡，正常为空） */
  finish(episodeId: string) {
    useWriterRunStore.setState((state) => {
      const run = state.runs[episodeId] ?? emptyRun()
      const messages =
        run.streamingText !== ''
          ? [...run.messages, { role: 'assistant' as const, text: run.streamingText }]
          : run.messages
      return withRun(state, episodeId, { ...run, messages, streamingText: '', running: false })
    })
  },
}

// ---- SSE 事件 → store（唯一入口，useWriterRun 调用；词汇见 #19 映射表）----

export function applyWriterSseEvent(episodeId: string, event: WriterSseEvent) {
  const write = (fn: (run: RunState) => RunState) =>
    useWriterRunStore.setState((state) => withRun(state, episodeId, fn(state.runs[episodeId] ?? emptyRun())))

  switch (event.event) {
    case 'run:start':
      // 用户气泡在 start() 已渲染，这里只标记进入生成态
      write((run) => ({ ...run, running: true }))
      break
    case 'delta':
      write((run) => ({ ...run, streamingText: run.streamingText + event.data.delta }))
      break
    case 'message:end':
      // 定稿：以 message:end 文本为准落一条气泡并清 streaming。
      // 一轮 run 可有多条 assistant 消息（工具调用分段），每条各自成气泡。
      write((run) => ({
        ...run,
        messages:
          event.data.text !== '' ? [...run.messages, { role: 'assistant' as const, text: event.data.text }] : run.messages,
        streamingText: '',
      }))
      break
    case 'tool:start':
      write((run) => ({
        ...run,
        tools: [...run.tools, { toolCallId: event.data.toolCallId, tool: event.data.tool, state: 'running' as const, summary: '' }],
      }))
      break
    case 'tool:end':
      write((run) => ({
        ...run,
        tools: run.tools.map((t) =>
          t.toolCallId === event.data.toolCallId
            ? { ...t, state: event.data.isError ? ('error' as const) : ('ok' as const), summary: event.data.summary }
            : t,
        ),
      }))
      break
    case 'script:changed':
      // 缓存失效由 useWriterRun 的防抖桥处理（唯一允许摸 QueryClient 的地方），store 不存
      break
    case 'turn:end':
      // 回合边界：MVP 无临时态要清
      break
    case 'done':
      writerRunActions.finish(episodeId)
      break
    case 'error':
      write((run) => ({ ...run, error: event.data.message }))
      writerRunActions.finish(episodeId)
      break
  }
}
