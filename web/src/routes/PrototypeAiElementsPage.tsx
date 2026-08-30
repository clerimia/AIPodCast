// PROTOTYPE（#33 POC，一次性可丢弃，不接生产）：AI Elements message 组件
// 在本项目栈（Vite 8 + React 19.2 + Tailwind v4 CSS-first + 自研 writer-run store）
// 的可用性验证。数据面走真实 store 入口（writerRunActions / applyWriterSseEvent），
// 渲染面用注入的 Message/MessageContent/MessageResponse；右栏复制现状 Bubble 作 A/B 对照。
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { cn } from '@/lib/utils'
import type { WriterSseEvent } from '@/lib/api/types'
import { applyWriterSseEvent, useWriterRunStore, writerRunActions } from '@/stores/writer-run'
import { GFM_STRESS, REAL_MESSAGE } from '@/routes/prototype-ai-elements-samples'

// 假单集 id，只存在于本页面的 store 分片
const EP = 'prototype-ai-elements'
const USER_PROMPT = '帮我写一版脚本草案'

type Mode = 'rAF 合帧' | '逐事件直写'

interface Stats {
  deltas: number
  storeWrites: number
  frames: number
  elapsedMs: number
}

const EMPTY_STATS: Stats = { deltas: 0, storeWrites: 0, frames: 0, elapsedMs: 0 }

export default function PrototypeAiElementsPage() {
  const run = useWriterRunStore((s) => s.runs[EP])
  const [mode, setMode] = useState<Mode>('rAF 合帧')
  const [stats, setStats] = useState<Stats>(EMPTY_STATS)
  const replayRef = useRef<{ cancel: () => void } | null>(null)
  const darkRef = useRef(false)

  // 页面卸载时停掉在途回放
  useEffect(() => () => replayRef.current?.cancel(), [])

  const toggleDark = () => {
    darkRef.current = !darkRef.current
    document.documentElement.classList.toggle('dark', darkRef.current)
  }

  const replay = (fullText: string) => {
    replayRef.current?.cancel()
    writerRunActions.load(EP, [])
    writerRunActions.start(EP, USER_PROMPT)

    const startedAt = performance.now()
    let deltas = 0
    let storeWrites = 0
    let frames = 0
    let buffer = ''
    let rafId: number | null = null
    let timerId: ReturnType<typeof setTimeout> | null = null
    let pos = 0
    let cancelled = false

    const publish = () => {
      setStats({ deltas, storeWrites, frames, elapsedMs: Math.round(performance.now() - startedAt) })
    }

    const applyEvent = (event: WriterSseEvent) => {
      applyWriterSseEvent(EP, event)
      if (event.event === 'delta') {
        storeWrites += 1
        publish()
      }
    }

    const flush = () => {
      rafId = null
      frames += 1
      if (cancelled || buffer === '') return
      const delta = buffer
      buffer = ''
      applyEvent({ event: 'delta', data: { delta } })
    }

    const pump = () => {
      if (cancelled) return
      if (pos >= fullText.length) {
        // 收尾：message:end 定稿 + done，与真实 SSE 词汇一致
        applyEvent({ event: 'message:end', data: { text: fullText } })
        applyEvent({ event: 'done', data: {} })
        publish()
        return
      }
      // 真实感切块：2~7 字符/事件，20~45ms 间隔（qwen3.7-plus 流式量级）
      const size = 2 + Math.floor(Math.random() * 6)
      const delta = fullText.slice(pos, pos + size)
      pos += size
      deltas += 1
      if (mode === 'rAF 合帧') {
        // M6 计划的合帧策略：delta 到达即入缓冲，每帧一次性写入 store
        buffer += delta
        if (rafId === null) rafId = requestAnimationFrame(flush)
      } else {
        applyEvent({ event: 'delta', data: { delta } })
      }
      timerId = setTimeout(pump, 20 + Math.random() * 25)
    }

    replayRef.current = {
      cancel: () => {
        cancelled = true
        if (rafId !== null) cancelAnimationFrame(rafId)
        if (timerId !== null) clearTimeout(timerId)
      },
    }
    setStats(EMPTY_STATS)
    pump()
  }

  const messages = run?.messages ?? []
  const streamingText = run?.streamingText ?? ''
  const running = run?.running ?? false

  return (
    <div className="flex h-dvh flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-base font-semibold">POC：AI Elements message（#33）— 可丢弃原型</h1>
        <Button size="sm" onClick={() => replay(REAL_MESSAGE)}>回放真实消息</Button>
        <Button size="sm" variant="outline" onClick={() => replay(GFM_STRESS)}>回放 GFM 压力样例</Button>
        <Button size="sm" variant="ghost" onClick={() => replayRef.current?.cancel()}>停止</Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setMode(m => (m === 'rAF 合帧' ? '逐事件直写' : 'rAF 合帧'))}
        >
          写入模式：{mode}
        </Button>
        <Button size="sm" variant="ghost" onClick={toggleDark}>切换浅/暗</Button>
      </header>
      <div className="text-xs text-muted-foreground">
        流式={running ? '进行中' : '空闲'} · delta 切块={stats.deltas} · store 写入={stats.storeWrites} ·
        rAF 帧={stats.frames} · 耗时={stats.elapsedMs}ms
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <StreamColumn
          title="AI Elements message（MessageResponse）"
          messages={messages}
          streamingText={streamingText}
          running={running}
        />
        <StreamColumn
          title="现状对照（whitespace-pre-wrap 气泡）"
          messages={messages}
          streamingText={streamingText}
          running={running}
          legacy
        />
      </div>
    </div>
  )
}

function StreamColumn({
  title,
  messages,
  streamingText,
  running,
  legacy = false,
}: {
  title: string
  messages: { role: 'user' | 'assistant'; text: string; toolCalls?: { tool: string; summary: string }[] }[]
  streamingText: string
  running: boolean
  legacy?: boolean
}) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, streamingText])

  return (
    <section className="flex min-h-0 flex-col rounded-lg border">
      <h2 className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">{title}</h2>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {messages.map((m, i) =>
          legacy ? (
            <LegacyBubble key={i} role={m.role} text={m.text} />
          ) : (
            <Message key={i} from={m.role}>
              <MessageContent>
                {m.role === 'assistant' ? <MessageResponse>{m.text}</MessageResponse> : m.text}
              </MessageContent>
            </Message>
          ),
        )}
        {streamingText !== '' &&
          (legacy ? (
            <LegacyBubble role="assistant" text={streamingText} streaming />
          ) : (
            <Message from="assistant">
              <MessageContent>
                <MessageResponse isAnimating={running}>{streamingText}</MessageResponse>
              </MessageContent>
            </Message>
          ))}
        <div ref={bottomRef} />
      </div>
    </section>
  )
}

// 现状渲染的复制品（ChatStream.tsx 的 Bubble），作渲染质量对照基线
function LegacyBubble({
  role,
  text,
  streaming = false,
}: {
  role: 'user' | 'assistant'
  text: string
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
    </div>
  )
}
