// writer 模块内共享的文本小工具（tools/history/sse 三处共用，避免重复实现）。

/** 拼接消息 content 里的 TextContent（兼容 string content；无 content 形状安全返回空） */
export function textContentOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c): c is { type: 'text'; text: string } => (c as { type?: string })?.type === 'text')
    .map((c) => c.text)
    .join('')
}

/** 拼接消息 content 里的思考块（history 回放 / message:end 收尾共用；ADR-0010） */
export function thinkingContentOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c): c is { type: 'thinking'; thinking: string } => (c as { type?: string })?.type === 'thinking')
    .map((c) => c.thinking)
    .join('')
}

/** 提取消息 content 里的 toolCall 块声明（message:end 归属词汇用，#35 复盘 3） */
export function toolCallDeclsOf(content: unknown): { toolCallId: string; tool: string }[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((c): c is { type: 'toolCall'; id: string; name: string } => (c as { type?: string })?.type === 'toolCall')
    .filter((c) => typeof c.id === 'string' && c.id !== '')
    .map((c) => ({ toolCallId: c.id, tool: c.name ?? 'tool' }))
}

/** 单行紧凑截断（回给模型/状态条/回放摘要共用） */
export function briefText(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}
