// 输入框：run 期间禁用（frontend-structure.md「暂停编辑窗口」）；运行中按钮变停止
//（POST abort）。Enter 发送、Shift+Enter 换行。思考开关（ADR-0010）：默认关，
// localStorage 持久化（key writer.thinking），随每条消息下发。
//
// 手感层：输入框整体包成一个「胶囊容器」——聚焦时整块亮边而不是只有 textarea 有焦点环，
// 发送/停止是同一个按钮的两种形态（位置不变，肌肉记忆不丢），高度随内容自增高到上限后内滚。
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Brain, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useWriterRunStore } from '@/stores/writer-run'

const THINKING_STORAGE_KEY = 'writer.thinking'
/** 自增高上限：再长就内部滚动，避免输入框把聊天区顶没 */
const MAX_HEIGHT_PX = 160

/** 思考模式开关的持久化偏好；空状态建议卡也要按它发（不能绕过用户的设置） */
export const loadThinkingPreference = (): boolean => {
  try {
    return localStorage.getItem(THINKING_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

const loadThinking = loadThinkingPreference

export function Composer({
  episodeId,
  registerFocus,
  onSend,
  onStop,
}: {
  episodeId: string
  /** 向上注册「聚焦输入框」动作（⌘I / 命令面板）。注册回调而非透传 DOM ref——
   * 调用方不需要知道这是个 textarea，也免去了跨组件 ref 赋值的时序问题 */
  registerFocus?: (focus: (() => void) | null) => void
  onSend: (text: string, thinking: boolean) => void
  onStop: () => void
}) {
  const running = useWriterRunStore((s) => s.runs[episodeId]?.running ?? false)
  const [text, setText] = useState('')
  const [thinking, setThinking] = useState(loadThinking)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!registerFocus) return
    registerFocus(() => inputRef.current?.focus())
    return () => registerFocus(null)
  }, [registerFocus])

  // 自增高：field-sizing-content 在 Safari 上还不稳，这里用 scrollHeight 手动算，行为可控
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [text])

  const toggleThinking = () => {
    setThinking((prev) => {
      const next = !prev
      try {
        localStorage.setItem(THINKING_STORAGE_KEY, String(next))
      } catch {
        // 隐私模式等存不进就仅本次会话生效
      }
      return next
    })
  }

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '' || running) return
    onSend(trimmed, thinking)
    setText('')
  }

  return (
    <div className="shrink-0 border-t p-2.5">
      <div
        className={cn(
          'rounded-xl border bg-background shadow-sm transition-all',
          'focus-within:border-brand-border focus-within:ring-4 focus-within:ring-brand/10',
        )}
      >
        <Textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={running ? '写稿大师正在生成…' : '让写稿大师改稿，例如「开场再短一点」'}
          disabled={running}
          rows={1}
          className="field-sizing-fixed min-h-9 resize-none overflow-y-auto border-none bg-transparent px-3 pt-2.5 pb-1 text-sm shadow-none focus-visible:border-none focus-visible:ring-0"
        />

        <div className="flex items-center gap-1 px-2 pb-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={thinking ? '关闭思考模式' : '开启思考模式'}
            aria-pressed={thinking}
            title={thinking ? '思考模式：开（回复更慢、先想后写）' : '思考模式：关'}
            className={cn('shrink-0 gap-1.5', thinking && 'bg-brand-soft text-brand hover:bg-brand-soft')}
            onClick={toggleThinking}
          >
            <Brain className={cn('size-3.5', thinking && 'animate-breathe')} />
            <span className="hidden text-xs sm:inline">思考</span>
          </Button>

          <span className="ml-auto hidden items-center gap-1 text-[11px] text-muted-foreground lg:flex">
            <Kbd>↵</Kbd> 发送
            <Kbd>⇧↵</Kbd> 换行
          </span>

          {/* 发送 / 停止是同一个按钮：位置固定，指针不用来回找 */}
          <Button
            type="button"
            size="icon"
            aria-label={running ? '停止生成' : '发送'}
            title={running ? '停止生成' : '发送（Enter）'}
            disabled={!running && text.trim() === ''}
            className={cn(
              'size-8 shrink-0 rounded-full bg-brand text-brand-foreground transition-all hover:bg-brand/90',
              'focus-visible:ring-brand/40',
            )}
            onClick={running ? onStop : submit}
          >
            {running ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
