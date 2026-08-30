// 写稿运行态 + 流控制（frontend-structure.md「数据流约定」）：一个模块统管——
// 运行态 store（流式气泡/状态条/错误）+ SSE 流的生命周期。流是模块级单例，与
// 组件挂载/卸载解耦：导航去工作间主页/设置再回来，消息流继续同步（服务端对客户端
// 断连只停写流、run 照跑完，客户端一旦断流就收不到增量了）。本模块是唯一允许直接
// 摸 QueryClient 的地方（单例在 lib/query-client.ts）。
// 气泡三块（ADR-0010）：思考（thinking）/ 正文（text）/ 工具调用（toolCalls）。
// rAF 合帧（#29 验证项 1）：delta/thinking 事件入缓冲 + schedule rAF，每帧一次性按序
// apply（帧内同 kind 合并）；非流式增量事件（message:end/done/error/script:changed）
// 应用前先同步 flush，避免定稿后残留 delta 写进下一条气泡。
import { create } from 'zustand'
import { toast } from 'sonner'
import { writerApi } from '@/lib/api/writer'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { queryClient } from '@/lib/query-client'
import type { WriterSseEvent } from '@/lib/api/types'

export interface ToolStatus {
  toolCallId: string
  tool: string
  /** running | ok | error */
  state: 'running' | 'ok' | 'error'
  summary: string
}

/** 气泡 Task 块里的工具调用条目：流式条目带 toolCallId（归属真相源，#35 复盘 3），
 * history 回放条目无 id（服务端已并好摘要，按序展示） */
export interface ChatToolCall {
  toolCallId?: string
  tool: string
  summary: string
  /** 流式条目：tool:end 前为 running；回放条目无此键（已完成） */
  state?: 'running' | 'ok' | 'error'
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  thinking?: string
  toolCalls?: ChatToolCall[]
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
  /** 工具状态条（只装当前窗口——上一条 message:end 之后的调用） */
  tools: ToolStatus[]
  /** 本轮累计完成的工具调用数（跨气泡累计，状态条进度用） */
  toolsDone: number
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
  toolsDone: 0,
  error: null,
})

function withRun(state: WriterRunState, episodeId: string, run: RunState): WriterRunState {
  return { runs: { ...state.runs, [episodeId]: run } }
}

/** 工具归属（#35 复盘 3）：message:end 自带 toolCalls 声明（toolCallId），tool:end
 * 按 id 回填摘要到声明它的气泡——不再按窗口位置推断，无正文消息的工具不会漂移。 */
function attributeToolEnd(messages: ChatMessage[], toolCallId: string, summary: string, isError: boolean): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !m.toolCalls?.some((tc) => tc.toolCallId === toolCallId)) return m
    return {
      ...m,
      toolCalls: m.toolCalls.map((tc) =>
        tc.toolCallId === toolCallId ? { ...tc, summary, state: isError ? ('error' as const) : ('ok' as const) } : tc,
      ),
    }
  })
}

export const useWriterRunStore = create<WriterRunState>(() => ({ runs: {} }))

// ---- 流控制（模块级单例：与组件生命周期解耦，导航离开编辑页流照跑）----

const SCRIPT_INVALIDATE_DEBOUNCE_MS = 300

type BufferedDelta = { kind: 'thinking' | 'text'; delta: string }

/** 一个进行中的流：请求中止柄 + rAF 合帧缓冲 + script 失效防抖柄 */
interface StreamLoop {
  controller: AbortController
  buf: BufferedDelta[]
  raf: number | null
  debounce: ReturnType<typeof setTimeout> | null
}

/** episodeId → 进行中的流 */
const loops = new Map<string, StreamLoop>()

/** 缓冲一次性按序写入 store（帧内同 kind 合并成一条增量，一次 setState 一段） */
function flushBuffer(episodeId: string, loop: StreamLoop) {
  if (loop.raf !== null) {
    cancelAnimationFrame(loop.raf)
    loop.raf = null
  }
  const buf = loop.buf
  if (buf.length === 0) return
  loop.buf = []
  for (const { kind, delta } of buf) {
    if (kind === 'thinking') applyWriterSseEvent(episodeId, { event: 'thinking', data: { delta } })
    else applyWriterSseEvent(episodeId, { event: 'delta', data: { delta } })
  }
}

function scheduleDelta(episodeId: string, loop: StreamLoop, kind: 'thinking' | 'text', delta: string) {
  const buf = loop.buf
  const last = buf[buf.length - 1]
  if (last && last.kind === kind) last.delta += delta
  else buf.push({ kind, delta })
  if (loop.raf === null) loop.raf = requestAnimationFrame(() => flushBuffer(episodeId, loop))
}

function invalidateScript(episodeId: string) {
  void queryClient.invalidateQueries({ queryKey: ['script', episodeId] })
}

function runStream(episodeId: string, text: string, thinking: boolean) {
  const loop: StreamLoop = { controller: new AbortController(), buf: [], raf: null, debounce: null }
  loops.set(episodeId, loop)

  const onEvent = (event: WriterSseEvent) => {
    // 流式增量走 rAF 合帧；其余事件先同步 flush 再应用（定稿前清残留增量）
    if (event.event === 'thinking') {
      scheduleDelta(episodeId, loop, 'thinking', event.data.delta)
      return
    }
    if (event.event === 'delta') {
      scheduleDelta(episodeId, loop, 'text', event.data.delta)
      return
    }
    flushBuffer(episodeId, loop)
    applyWriterSseEvent(episodeId, event)
    if (event.event === 'script:changed') {
      // 防抖 300ms：一轮多工具只重拉一两次（frontend-structure.md）
      if (loop.debounce) clearTimeout(loop.debounce)
      loop.debounce = setTimeout(() => invalidateScript(episodeId), SCRIPT_INVALIDATE_DEBOUNCE_MS)
    }
    if (event.event === 'done') {
      invalidateScript(episodeId)
    }
    if (event.event === 'error') {
      toast.error(`写稿大师出错：${event.data.message}`)
    }
  }

  void writerApi
    .sendMessage(episodeId, text, thinking, onEvent, loop.controller.signal)
    .catch((err: unknown) => {
      // 流层失败（网络/409 busy/5xx）：SSE error 事件已处理过运行态，这里兜底
      flushBuffer(episodeId, loop)
      if ((err as Error)?.name === 'AbortError') {
        writerRunActions.finish(episodeId)
      } else {
        applyWriterSseEvent(episodeId, { event: 'error', data: { message: apiErrorMessage(err) } })
        toast.error(`写稿大师出错：${apiErrorMessage(err)}`)
      }
    })
    .finally(() => {
      if (loop.debounce) clearTimeout(loop.debounce)
      if (loop.raf !== null) cancelAnimationFrame(loop.raf)
      loops.delete(episodeId)
    })
}

// ---- actions（组件/hook 经此消费，不直接 setState）----

export const writerRunActions = {
  /** 进入页面/重置：装载历史气泡 */
  load(episodeId: string, history: ChatMessage[]) {
    useWriterRunStore.setState((state) => withRun(state, episodeId, emptyRun(history)))
  },

  /** 发消息并启动 SSE 流；运行中幂等忽略（输入框本就禁用，双保险） */
  send(episodeId: string, text: string, thinking: boolean) {
    if (useWriterRunStore.getState().runs[episodeId]?.running) return
    writerRunActions.start(episodeId, text)
    runStream(episodeId, text, thinking)
  },

  /** 请求服务端中止当前 run（幂等）；SSE 以 done 收尾后本地统一 finish */
  async stop(episodeId: string) {
    try {
      await writerApi.abort(episodeId)
    } catch (err) {
      toast.error(`停止失败：${apiErrorMessage(err)}`)
    }
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
        toolsDone: 0,
        error: null,
      })
    })
  },

  /** 收尾：仍在 running 的工具调用条目标为已中止（tool:end 不会再来了）。
   * 状态条不残留：done/abort 清工具清单与错误；error 仅保留错误行供阅读（下次 start 清）。
   * done 另失效 writerHistory：以服务端回放（toolCalls 摘要/分组）为准做最终对齐。 */
  finish(episodeId: string, outcome: 'done' | 'error' | 'abort' = 'done') {
    if (outcome === 'done') {
      void queryClient.invalidateQueries({ queryKey: qk.writerHistory(episodeId) })
    }
    useWriterRunStore.setState((state) => {
      const run = state.runs[episodeId] ?? emptyRun()
      const settled = run.messages.map((m) => {
        if (m.role !== 'assistant' || !m.toolCalls?.some((tc) => tc.state === 'running')) return m
        return {
          ...m,
          toolCalls: m.toolCalls.map((tc) =>
            tc.state === 'running' ? { ...tc, state: 'error' as const, summary: '已中止' } : tc,
          ),
        }
      })
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
        messages: [...settled, ...residual],
        streamingText: '',
        streamingThinking: '',
        thinkingActive: false,
        running: false,
        tools: [],
        ...(outcome === 'error' ? {} : { error: null }),
      })
    })
  },
}

// ---- SSE 事件 → store（唯一入口，本模块流控制调用；词汇见 #19 映射表 + ADR-0010）----

function applyWriterSseEvent(episodeId: string, event: WriterSseEvent) {
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
    case 'message:end': {
      // 定稿：以 message:end 为准落一条气泡（text + thinking + 声明的 toolCalls）并清全部
      // 流式态。一轮 run 可有多条 assistant 消息（工具调用分段），每条各自成气泡；
      // 无正文但声明了工具调用的消息也要落（否则其工具没有归属地，#35 复盘 3）。
      // 工具摘要随后按 toolCallId 由 tool:end 回填，不再按窗口位置推断。
      write((run) => {
        const declared = event.data.toolCalls ?? []
        const messages =
          event.data.text !== '' || event.data.thinking || declared.length > 0
            ? [
                ...run.messages,
                {
                  role: 'assistant' as const,
                  text: event.data.text,
                  ...(event.data.thinking && { thinking: event.data.thinking }),
                  ...(declared.length > 0 && {
                    toolCalls: declared.map(
                      (tc): ChatToolCall => ({ toolCallId: tc.toolCallId, tool: tc.tool, summary: '', state: 'running' as const }),
                    ),
                  }),
                },
              ]
            : run.messages
        return {
          ...run,
          messages,
          streamingText: '',
          streamingThinking: '',
          thinkingActive: false,
          tools: [],
        }
      })
      break
    }
    case 'tool:start':
      write((run) => ({
        ...run,
        tools: [...run.tools, { toolCallId: event.data.toolCallId, tool: event.data.tool, state: 'running' as const, summary: '' }],
      }))
      break
    case 'tool:end':
      write((run) => ({
        ...run,
        toolsDone: run.toolsDone + 1,
        // 归属：按 toolCallId 回填到声明它的气泡（历史条目无 id 不受影响）
        messages: attributeToolEnd(run.messages, event.data.toolCallId, event.data.summary, event.data.isError),
        tools: run.tools.map((t) =>
          t.toolCallId === event.data.toolCallId
            ? { ...t, state: event.data.isError ? ('error' as const) : ('ok' as const), summary: event.data.summary }
            : t,
        ),
      }))
      break
    case 'script:changed':
      // 缓存失效由本模块的防抖桥处理（runStream 内），store 不存
      break
    case 'turn:end':
      // 回合边界：MVP 无临时态要清
      break
    case 'done':
      writerRunActions.finish(episodeId)
      break
    case 'error':
      write((run) => ({ ...run, error: event.data.message }))
      writerRunActions.finish(episodeId, 'error')
      break
  }
}
