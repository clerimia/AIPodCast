// 聊天气泡流：历史气泡 + 本轮用户气泡 + 流式 assistant 气泡。数据全部来自
// stores/writer-run.ts（useWriterRun 写入），组件只读。自动滚到底部。
// assistant 气泡三块结构（ADR-0010）：思考 Reasoning / 工具 Task / 正文 MessageResponse；
// user 气泡保持自定义样式。
import { useEffect, useRef } from 'react'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task'
import { toolLabel } from '@/features/writer-chat/RunStatusBar'
import { cn } from '@/lib/utils'
import { useWriterRunStore } from '@/stores/writer-run'

export function ChatStream({ episodeId }: { episodeId: string }) {
  const run = useWriterRunStore((s) => s.runs[episodeId])
  const bottomRef = useRef<HTMLDivElement>(null)

  const messages = run?.messages ?? []
  const streamingText = run?.streamingText ?? ''
  const streamingThinking = run?.streamingThinking ?? ''

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, streamingText, streamingThinking])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
      {messages.length === 0 && streamingText === '' && streamingThinking === '' && (
        <p className="m-auto text-sm text-muted-foreground">
          和写稿大师聊聊这一集吧，例如「写段开场白」。
        </p>
      )}
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <div key={i} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
            {m.text}
          </div>
        ) : (
          <AssistantBubble key={i} text={m.text} thinking={m.thinking} toolCalls={m.toolCalls} />
        ),
      )}
      {(streamingText !== '' || streamingThinking !== '') && (
        <Message from="assistant">
          <MessageContent className={cn('opacity-90')}>
            {streamingThinking !== '' && (
              <Reasoning isStreaming={run?.thinkingActive ?? false}>
                <ReasoningTrigger />
                <ReasoningContent>{streamingThinking}</ReasoningContent>
              </Reasoning>
            )}
            {streamingText !== '' && <MessageResponse isAnimating={run?.running ?? false}>{streamingText}</MessageResponse>}
          </MessageContent>
        </Message>
      )}
      <div ref={bottomRef} />
    </div>
  )
}

function AssistantBubble({
  text,
  thinking,
  toolCalls,
}: {
  text: string
  thinking?: string
  toolCalls?: { tool: string; summary: string }[]
}) {
  return (
    <Message from="assistant">
      <MessageContent>
        {thinking && (
          <Reasoning isStreaming={false}>
            <ReasoningTrigger />
            <ReasoningContent>{thinking}</ReasoningContent>
          </Reasoning>
        )}
        {toolCalls && toolCalls.length > 0 && (
          <Task>
            <TaskTrigger title={`脚本操作（${toolCalls.length} 步）`} />
            <TaskContent>
              {toolCalls.map((tc, i) => (
                <TaskItem key={i}>
                  {toolLabel(tc.tool)}：{tc.summary || '完成'}
                </TaskItem>
              ))}
            </TaskContent>
          </Task>
        )}
        {text !== '' && <MessageResponse>{text}</MessageResponse>}
      </MessageContent>
    </Message>
  )
}
