// 写稿运行态（frontend-structure.md stores/writer-run.ts）：流式气泡 + 运行状态 +
// 工具状态条，按 episodeId 区分。SSE 事件由 useWriterRun 写入；组件只读。
// 气泡三块（ADR-0010）：思考（thinking）/ 正文（text）/ 工具调用（toolCalls）。
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
  thinking?: string
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
  /** 当前流式中的思考内容（ADR-0010；随 delta/message:end 事件清位） */
  streamingThinking: string
  /** 思考是否仍在增量（delta 一到即转为正文阶段） */
  thinkingActive: boolean
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
  streamingThinking: '',
  thinkingActive: false,
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
        streamingThinking: '',
        thinkingActive: false,
        running: true,
        tools: [],
        error: null,
      })
    })
  },

  /** 收尾：残留流式内容兜底落气泡（message:end 已逐条落气泡，正常为空） */
  finish(episodeId: string) {
    useWriterRunStore.setState((state) => {
      const run = state.runs[episodeId] ?? emptyRun()
      const residual =
        run.streamingText !== '' || run.streamingThinking !== ''
          ? [
              {
                role: 'assistant' as const,
                text: run.streamingText,
                ...(run.streamingThinking !== '' && { thinking: run.streamingThinking }),
              },
            ]
          : []
      return withRun(state, episodeId, {
        ...run,
        messages: [...run.messages, ...residual],
        streamingText: '',
        streamingThinking: '',
        thinkingActive: false,
        running: false,
      })
    })
  },
}

// ---- SSE 事件 → store（唯一入口，useWriterRun 调用；词汇见 #19 映射表 + ADR-0010）----

export function applyWriterSseEvent(episodeId: string, event: WriterSseEvent) {
  const write = (fn: (run: RunState) => RunState) =>
    useWriterRunStore.setState((state) => withRun(state, episodeId, fn(state.runs[episodeId] ?? emptyRun())))

  switch (event.event) {
    case 'run:start':
      // 用户气泡在 start() 已渲染，这里只标记进入生成态
      write((run) => ({ ...run, running: true }))
      break
    case 'thinking':
      write((run) => ({
        ...run,
        streamingThinking: run.streamingThinking + event.data.delta,
        thinkingActive: true,
      }))
      break
    case 'delta':
      write((run) => ({
        ...run,
        streamingText: run.streamingText + event.data.delta,
        thinkingActive: false,
      }))
      break
    case 'message:end':
      // 定稿：以 message:end 为准落一条气泡（text + thinking）并清全部流式态。
      // 一轮 run 可有多条 assistant 消息（工具调用分段），每条各自成气泡；
      // thinking-only（无正文）也要落——与 history 回放一致；两者皆空（错误占位）不落。
      write((run) => ({
        ...run,
        messages:
          event.data.text !== '' || event.data.thinking
            ? [
                ...run.messages,
                {
                  role: 'assistant' as const,
                  text: event.data.text,
                  ...(event.data.thinking && { thinking: event.data.thinking }),
                },
              ]
            : run.messages,
        streamingText: '',
        streamingThinking: '',
        thinkingActive: false,
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
