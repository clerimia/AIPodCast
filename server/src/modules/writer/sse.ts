// PI SDK 事件 → 浏览器 SSE 事件词汇（docs/api-and-dataflow.md「SSE 事件协议」映射表，
// #19）。前端只认这套词汇，不依赖 PI 事件名。
// 偏差说明：#19 表里 error 事件来源含 tool_execution_end(isError:true)，但工具报错
// 后模型会在同一 run 内看到错误结果并自纠（agent-core 继续循环），关流会吞掉恢复
// 过程——故 tool 错误走 tool:end.isError 呈现，error 事件只用于 run 级失败
// （assistant 消息 stopReason=error 且 willRetry:false / 后端异常）。
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { textContentOf, thinkingContentOf } from './text.js'
import type { WriterToolDetails } from './tools.js'

export type BrowserSseEvent =
  | { event: 'run:start'; data: Record<string, never> }
  | { event: 'thinking'; data: { delta: string } }
  | { event: 'delta'; data: { delta: string } }
  | { event: 'message:end'; data: { text: string; thinking?: string } }
  | { event: 'tool:start'; data: { toolCallId: string; tool: string } }
  | {
      event: 'tool:end'
      data: { toolCallId: string; tool: string; ok: boolean; isError: boolean; summary: string; lineIds: string[] }
    }
  | { event: 'script:changed'; data: { lineIds: string[] } }
  | { event: 'turn:end'; data: Record<string, never> }
  | { event: 'done'; data: Record<string, never> }
  | { event: 'error'; data: { message: string } }

/** agent 消息的纯文本（content 里 TextContent 拼接；BashExecutionMessage 等无 content 形状安全跳过） */
function messageText(message: unknown): string {
  return textContentOf((message as { content?: unknown } | null | undefined)?.content)
}

/** 错误信息提取：assistant 消息 stopReason=error 时的 errorMessage */
function runErrorOf(event: Extract<AgentSessionEvent, { type: 'agent_end' }>): string | null {
  for (const message of event.messages) {
    const m = message as { role?: string; stopReason?: string; errorMessage?: string }
    if (m.role === 'assistant' && m.stopReason === 'error') {
      return m.errorMessage ?? '模型返回错误'
    }
  }
  return null
}

/**
 * 订阅一次 run 并把 PI 事件翻译成浏览器事件，逐个回调 emit。
 * 返回值：run 结束方式——'done'（agent_settled）| 'error'（run 级失败，message 已 emit）。
 * 用法：先建 SSE 通道 → run() → await session.prompt(text) → end 回调收尾。
 */
export function runWriterSession(
  session: AgentSession,
  emit: (event: BrowserSseEvent) => void,
  onDone: (ended: 'done' | 'error') => void,
): void {
  // script:changed 在 tool:end 之后立即派生（tool ∈ {add,edit} 时），#19 映射表
  const toolsThatWriteScript = new Set(['add', 'edit'])
  let settled = false
  const finish = (ended: 'done' | 'error') => {
    if (settled) return
    settled = true
    off()
    onDone(ended)
  }

  const off = session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case 'agent_start':
        emit({ event: 'run:start', data: {} })
        break
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          emit({ event: 'delta', data: { delta: event.assistantMessageEvent.delta } })
        }
        // 思考增量（ADR-0010）：仅思考开启时产生；关 = 无思考事件，词汇向后兼容
        if (event.assistantMessageEvent.type === 'thinking_delta') {
          emit({ event: 'thinking', data: { delta: event.assistantMessageEvent.delta } })
        }
        break
      case 'message_end': {
        // 只回放 assistant 正文（user 消息端由请求体已知）
        const message = event.message as { role?: string }
        if (message.role === 'assistant') {
          const text = messageText(event.message)
          const thinking = thinkingContentOf((event.message as { content?: unknown }).content)
          // 事件 data 里思考为空不携带该键（前端以 in/真值判三块）
          if (text || thinking) emit({ event: 'message:end', data: { text, ...(thinking && { thinking }) } })
        }
        break
      }
      case 'tool_execution_start':
        emit({ event: 'tool:start', data: { toolCallId: event.toolCallId, tool: event.toolName } })
        break
      case 'tool_execution_end': {
        const details = (event.result as { details?: WriterToolDetails } | undefined)?.details
        const summary = details?.summary ?? `${event.toolName} 完成`
        const lineIds = details?.lineIds ?? []
        emit({
          event: 'tool:end',
          data: {
            toolCallId: event.toolCallId,
            tool: event.toolName,
            ok: !event.isError,
            isError: event.isError,
            summary,
            lineIds,
          },
        })
        if (!event.isError && toolsThatWriteScript.has(event.toolName)) {
          // #19：tool ∈ {add,edit} 成功后派生 script:changed，前端防抖重拉 GET script
          //（纯 reorder/纯 add 时 lineIds 可能为空，仍要发——刷新依赖事件本身）
          emit({ event: 'script:changed', data: { lineIds } })
        }
        break
      }
      case 'turn_end':
        emit({ event: 'turn:end', data: {} })
        break
      case 'agent_end':
        if (!event.willRetry) {
          const runError = runErrorOf(event)
          if (runError) {
            emit({ event: 'error', data: { message: runError } })
            finish('error')
          }
        }
        break
      case 'agent_settled':
        emit({ event: 'done', data: {} })
        finish('done')
        break
      default:
        // queue_update / compaction_* / auto_retry_* 等 MVP 不转发
        break
    }
  })
}
