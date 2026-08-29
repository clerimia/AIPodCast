// 会话历史回放（docs/api-and-dataflow.md「写稿大师会话（SSE）」history 节）：
// 读 session JSONL（SessionManager.parseSessionEntries）→ 浏览器友好列表。
// change_set 等 display:false 的 custom_message 不回放；条目结构对齐 SessionEntry。
import { existsSync, readFileSync } from 'node:fs'
import { parseSessionEntries, type FileEntry, type SessionMessageEntry } from '@earendil-works/pi-coding-agent'
import { briefText, textContentOf } from './text.js'

export interface WriterHistoryToolCall {
  tool: string
  summary: string
}

export interface WriterHistoryEntry {
  role: 'user' | 'assistant'
  text: string
  toolCalls?: WriterHistoryToolCall[]
}

/** 解析 session JSONL → 回放列表；文件不存在/损坏 → 空列表（会话还没开始过） */
export function parseWriterHistory(sessionFile: string | null | undefined): WriterHistoryEntry[] {
  if (!sessionFile || !existsSync(sessionFile)) return []
  let entries: FileEntry[]
  try {
    entries = parseSessionEntries(readFileSync(sessionFile, 'utf8'))
  } catch {
    return []
  }

  // 先收集 toolCallId → 结果摘要（toolResult 在独立消息里，回放时并入 assistant 的 toolCalls）
  const toolSummaries = new Map<string, string>()
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const message = (entry as SessionMessageEntry).message as {
      role?: string
      toolCallId?: string
      toolName?: string
      content?: unknown
    }
    if (message.role === 'toolResult' && message.toolCallId) {
      const text = textContentOf(message.content)
      if (text) toolSummaries.set(message.toolCallId, briefText(text))
    }
  }

  const out: WriterHistoryEntry[] = []
  for (const entry of entries) {
    // custom_message：change_set（display:false）不回放；其余 custom 类型当前不存在
    if (entry.type === 'custom_message') continue
    if (entry.type !== 'message') continue
    const message = (entry as SessionMessageEntry).message as {
      role?: string
      content?: unknown
      stopReason?: string
    }
    if (message.role === 'user') {
      const text = textContentOf(message.content)
      if (text) out.push({ role: 'user', text })
      continue
    }
    if (message.role === 'assistant') {
      // content 里的 toolCall 块 → toolCalls（摘要取对应 toolResult）
      const blocks = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []
      const toolCalls: WriterHistoryToolCall[] = []
      for (const block of blocks) {
        if (block.type !== 'toolCall') continue
        const id = block.id as string | undefined
        toolCalls.push({
          tool: (block.name as string) ?? 'tool',
          summary: (id !== undefined && toolSummaries.get(id)) || '',
        })
      }
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('')
      // 错误占位消息（无正文无工具调用）不回放
      if (!text && toolCalls.length === 0) continue
      out.push({ role: 'assistant', text, ...(toolCalls.length > 0 && { toolCalls }) })
    }
    // toolResult 消息已并入 assistant.toolCalls，不单列
  }
  return out
}
