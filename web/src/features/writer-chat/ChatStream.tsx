// 聊天气泡流：历史气泡 + 本轮用户气泡 + 流式 assistant 气泡。数据全部来自
// stores/writer-run.ts（writerRunActions 写入），组件只读。滚动策略：全程不自动
// 跟滚（生成中的流式增量/气泡定稿都不挪动视口）；仅自己发消息时回底一次；上翻后
// 底部中央浮出「回到底部」按钮。
// assistant 气泡三块结构（ADR-0010）：思考 Reasoning / 工具 Task / 正文 MessageResponse；
// user 气泡走同一套 Message/MessageContent（此前手搓 div，与 assistant 的样式体系割裂）。
// 工具 Task 块开合：本轮生成中默认展开（只有本轮用户消息之后出现的气泡跟随 running，
// 历史气泡不跟着新 run 一起翻展开），run 结束自动收起，用户手动开合后以手动为准。
// key 带 episodeId：路由参数切单集不重挂载组件，靠 key 强制重置气泡内状态。
import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  BookOpen,
  Check,
  ChevronDown as ChevronDownIcon,
  CheckCircle2,
  Copy,
  Loader2,
  PencilLine,
  Plus,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { toolLabel } from '@/features/writer-chat/RunStatusBar'
import { cn } from '@/lib/utils'
import type { ChatToolCall } from '@/stores/writer-run'
import { useWriterRunStore } from '@/stores/writer-run'

/** 距底部多少像素内算「贴底」 */
const AT_BOTTOM_THRESHOLD_PX = 40

/** 空状态建议：写稿是「不知道从哪下嘴」最容易卡住的一步，给几个能直接点的起手式 */
const SUGGESTIONS = [
  '写一段 30 秒的开场白',
  '把语气改得更口语一点',
  '两人就这个观点争论一段',
  '结尾加一句总结和收听引导',
]

export function ChatStream({
  episodeId,
  onSuggest,
}: {
  episodeId: string
  /** 点空状态建议卡 = 直接以该文案发起一轮 run */
  onSuggest?: (text: string) => void
}) {
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

  const isEmpty = messages.length === 0 && streamingText === '' && streamingThinking === ''

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="scrollbar-slim flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
      >
        {isEmpty && <EmptyState onSuggest={onSuggest} />}

        {messages.map((m, i) =>
          m.role === 'user' ? (
            <Message key={`${episodeId}-${i}`} from="user">
              <MessageContent className="group-[.is-user]:animate-rise group-[.is-user]:bg-brand-soft group-[.is-user]:px-3 group-[.is-user]:py-2 group-[.is-user]:text-foreground">
                <span className="whitespace-pre-wrap break-words">{m.text}</span>
              </MessageContent>
            </Message>
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
          <Message from="assistant" className="animate-rise">
            <MessageContent>
              {streamingThinking !== '' && (
                <Reasoning isStreaming={run?.thinkingActive ?? false}>
                  <ReasoningTrigger />
                  <ReasoningContent>{streamingThinking}</ReasoningContent>
                </Reasoning>
              )}
              {streamingText !== '' && (
                <MessageResponse isAnimating={run?.running ?? false}>{streamingText}</MessageResponse>
              )}
            </MessageContent>
          </Message>
        )}
      </div>

      {/* 回到底部：上翻阅读历史时唯一需要它；贴底时自动隐藏 */}
      {showJumpButton && (
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          aria-label="回到底部"
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-lg"
          onClick={jumpToBottom}
        >
          <ArrowDown />
        </Button>
      )}
    </div>
  )
}

function EmptyState({ onSuggest }: { onSuggest?: (text: string) => void }) {
  return (
    <div className="m-auto flex max-w-xs animate-rise flex-col items-center gap-3 py-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl bg-brand-soft text-brand">
        <Sparkles className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">写稿大师</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          用大白话描述你想要什么，它会直接读改写这份脚本——改完的行会标成待提交。
        </p>
      </div>
      {onSuggest && (
        <div className="mt-1 flex flex-wrap justify-center gap-1.5">
          {SUGGESTIONS.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => onSuggest(text)}
              className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-brand-border hover:bg-brand-soft hover:text-foreground"
            >
              {text}
            </button>
          ))}
        </div>
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
  toolCalls?: ChatToolCall[]
  /** 所属 run 生成中（仅本轮气泡为 true）：默认展开，结束收起 */
  liveOpen: boolean
}) {
  // 工具块开合：默认跟 liveOpen；用户手动开合后以手动为准
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? liveOpen

  return (
    <Message from="assistant" className="group/bubble animate-rise">
      <MessageContent>
        {thinking && (
          <Reasoning isStreaming={false}>
            <ReasoningTrigger />
            <ReasoningContent>{thinking}</ReasoningContent>
          </Reasoning>
        )}
        {toolCalls && toolCalls.length > 0 && (
          <Task open={open} onOpenChange={setUserOpen}>
            <TaskTrigger title={`脚本操作（${toolCalls.length} 步）`}>
              <TaskTriggerFace count={toolCalls.length} running={toolCalls.some((tc) => tc.state === 'running')} />
            </TaskTrigger>
            <TaskContent>
              {toolCalls.map((tc, i) => (
                <ToolCallRow key={tc.toolCallId ?? i} call={tc} />
              ))}
            </TaskContent>
          </Task>
        )}
        {text !== '' && (
          <>
            <MessageResponse>{text}</MessageResponse>
            {text !== '' && <CopyButton text={text} />}
          </>
        )}
      </MessageContent>
    </Message>
  )
}

/** 工具图标：读 / 写 / 改 三个动作各一个，列表扫一眼就知道这步在干什么 */
const TOOL_ICON: Record<string, typeof PencilLine> = {
  read: BookOpen,
  add: Plus,
  edit: PencilLine,
}

function ToolCallRow({ call }: { call: ChatToolCall }) {
  const Icon = TOOL_ICON[call.tool] ?? PencilLine
  // 流式条目带 state；历史回放条目无 id 也无 state，按已完成展示
  const state = call.state ?? 'ok'
  return (
    <TaskItem className="flex items-center gap-2 text-xs">
      {state === 'running' ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-brand" />
      ) : state === 'error' ? (
        <XCircle className="size-3 shrink-0 text-destructive" />
      ) : (
        // 完成态用工具自己的图标（读/写/改一眼区分），颜色只承担「成功」这一层信息
        <Icon className="size-3 shrink-0 text-emerald-600" />
      )}
      <span className="shrink-0 font-medium text-foreground">{toolLabel(call.tool)}</span>
      <span
        className={cn('min-w-0 truncate', state === 'error' ? 'text-destructive' : 'text-muted-foreground')}
      >
        {call.summary || (state === 'running' ? '执行中…' : '完成')}
      </span>
    </TaskItem>
  )
}

/** Task 折叠头的自定义面：整体在跑就转圈，跑完收成一个静态的「已改 N 步」 */
function TaskTriggerFace({ count, running }: { count: number; running: boolean }) {
  return (
    <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
      {running ? (
        <Loader2 className="size-3.5 animate-spin text-brand" />
      ) : (
        <CheckCircle2 className="size-3.5 text-emerald-600" />
      )}
      <p className="text-sm">脚本操作（{count} 步）</p>
      <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
    </div>
  )
}

/** 复制正文：产物是 markdown 原文，复制出去能直接粘到别处 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.error('复制失败：浏览器拒绝了剪贴板访问')
    }
  }

  return (
    <div className="flex opacity-0 transition-opacity group-hover/bubble:opacity-100 focus-within:opacity-100">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="复制正文"
        title="复制正文"
        onClick={() => void copy()}
      >
        {copied ? <Check className="size-3 text-emerald-600" /> : <Copy className="size-3" />}
      </Button>
    </div>
  )
}
