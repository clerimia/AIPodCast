// 聊天气泡流：历史气泡 + 本轮用户气泡 + 流式 assistant 气泡。数据全部来自
// stores/writer-run.ts（useWriterRun 写入），组件只读。自动滚到底部。
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { useWriterRunStore } from '@/stores/writer-run'

export function ChatStream({ episodeId }: { episodeId: string }) {
  const run = useWriterRunStore((s) => s.runs[episodeId])
  const bottomRef = useRef<HTMLDivElement>(null)

  const messages = run?.messages ?? []
  const streamingText = run?.streamingText ?? ''

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, streamingText])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
      {messages.length === 0 && streamingText === '' && (
        <p className="m-auto text-sm text-muted-foreground">
          和写稿大师聊聊这一集吧，例如「写段开场白」。
        </p>
      )}
      {messages.map((m, i) => (
        <Bubble key={i} role={m.role} text={m.text} toolCalls={m.toolCalls} />
      ))}
      {streamingText !== '' && <Bubble role="assistant" text={streamingText} streaming />}
      <div ref={bottomRef} />
    </div>
  )
}

function Bubble({
  role,
  text,
  toolCalls,
  streaming = false,
}: {
  role: 'user' | 'assistant'
  text: string
  toolCalls?: { tool: string; summary: string }[]
  streaming?: boolean
}) {
  return (
    <div
      className={cn(
        'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
        role === 'user' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted',
        streaming && 'opacity-90',
      )}
    >
      {text}
      {toolCalls?.map((tc, i) => (
        <p key={i} className="mt-1 text-xs text-muted-foreground">
          使用 {tc.tool}：{tc.summary || '完成'}
        </p>
      ))}
    </div>
  )
}
