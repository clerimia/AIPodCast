// 聊天气泡流：历史气泡 + 本轮用户气泡 + 流式 assistant 气泡。数据全部来自
// stores/writer-run.ts（writerRunActions 写入），组件只读。滚动策略：全程不自动
// 跟滚（生成中的流式增量/气泡定稿都不挪动视口）；仅自己发消息时回底一次；上翻后
// 底部中央浮出「回到底部」按钮。
// assistant 气泡三块结构（ADR-0010）：思考 Reasoning / 工具 Task / 正文 MessageResponse；
// user 气泡保持自定义样式。工具 Task 块开合：本轮生成中默认展开（只有本轮用户消息
// 之后出现的气泡跟随 running，历史气泡不跟着新 run 一起翻展开），run 结束自动收起，
// 用户手动开合后以手动为准（历史气泡装载即收起态）。
// key 带 episodeId：路由参数切单集不重挂载组件，靠 key 强制重置气泡内状态。
import { useEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task'
import { Button } from '@/components/ui/button'
import { toolLabel } from '@/features/writer-chat/RunStatusBar'
import { cn } from '@/lib/utils'
import { useWriterRunStore } from '@/stores/writer-run'

/** 距底部多少像素内算「贴底」 */
const AT_BOTTOM_THRESHOLD_PX = 40

export function ChatStream({ episodeId }: { episodeId: string }) {
  const run = useWriterRunStore((s) => s.runs[episodeId])
  const containerRef = useRef<HTMLDivElement>(null)
  const [showJumpButton, setShowJumpButton] = useState(false)

  const messages = run?.messages ?? []
  const lastRole = messages[messages.length - 1]?.role
  const streamingText = run?.streamingText ?? ''
  const streamingThinking = run?.streamingThinking ?? ''
  // 最近一条用户消息的下标：其后出现的 assistant 气泡都属于本轮 run
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIndex = i
      break
    }
  }

  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD_PX
    setShowJumpButton(!atBottom)
  }

  const jumpToBottom = () => {
    setShowJumpButton(false)
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' })
  }

  // 只改滚动位置不动 React 状态：scrollTop 赋值触发的 onScroll 会收敛按钮可见性
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // 自己刚发消息（用户气泡已落、流式未开始）→ 回底一次；其余（流式增量、
    // 气泡定稿、块收起）一律不挪动视口
    if (lastRole === 'user' && streamingText === '' && streamingThinking === '') {
      el.scrollTop = el.scrollHeight
    }
  }, [messages.length, streamingText, streamingThinking, lastRole])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3"
      >
        {messages.length === 0 && streamingText === '' && streamingThinking === '' && (
          <p className="m-auto text-sm text-muted-foreground">
            和写稿大师聊聊这一集吧，例如「写段开场白」。
          </p>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={`${episodeId}-${i}`} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
              {m.text}
            </div>
          ) : (
            <AssistantBubble
              key={`${episodeId}-${i}`}
              text={m.text}
              thinking={m.thinking}
              toolCalls={m.toolCalls}
              liveOpen={run?.running === true && i > lastUserIndex}
            />
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
      </div>
      {showJumpButton && (
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          aria-label="回到底部"
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 shadow-md"
          onClick={jumpToBottom}
        >
          <ArrowDown />
        </Button>
      )}
    </div>
  )
}

function AssistantBubble({
  text,
  thinking,
  toolCalls,
  liveOpen,
}: {
  text: string
  thinking?: string
  toolCalls?: { tool: string; summary: string }[]
  /** 所属 run 生成中（仅本轮气泡为 true）：默认展开，结束收起 */
  liveOpen: boolean
}) {
  // 工具块开合：默认跟 liveOpen；用户手动开合后以手动为准
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? liveOpen

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
          <Task open={open} onOpenChange={setUserOpen}>
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
