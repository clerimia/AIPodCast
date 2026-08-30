// 输入框：run 期间禁用（frontend-structure.md「暂停编辑窗口」）；运行中显示停止按钮
//（POST abort）。Enter 发送、Shift+Enter 换行。思考开关（ADR-0010）：默认关，
// localStorage 持久化（key writer.thinking），随每条消息下发。
import { useState } from 'react'
import { Brain, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useWriterRunStore } from '@/stores/writer-run'

const THINKING_STORAGE_KEY = 'writer.thinking'

const loadThinking = (): boolean => {
  try {
    return localStorage.getItem(THINKING_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function Composer({
  episodeId,
  onSend,
  onStop,
}: {
  episodeId: string
  onSend: (text: string, thinking: boolean) => void
  onStop: () => void
}) {
  const running = useWriterRunStore((s) => s.runs[episodeId]?.running ?? false)
  const [text, setText] = useState('')
  const [thinking, setThinking] = useState(loadThinking)

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
    <div className="flex items-end gap-2 border-t p-2">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={thinking ? '关闭思考模式' : '开启思考模式'}
        aria-pressed={thinking}
        title={thinking ? '思考模式：开（回复更慢、先想后写）' : '思考模式：关'}
        className={cn('shrink-0', thinking && 'text-primary')}
        onClick={toggleThinking}
      >
        <Brain />
      </Button>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={running ? '写稿大师正在生成…' : '给写稿大师发消息（Enter 发送）'}
        disabled={running}
        rows={2}
        className="min-h-0 resize-none"
      />
      {running ? (
        <Button variant="destructive" size="sm" onClick={onStop}>
          <Square /> 停止
        </Button>
      ) : (
        <Button size="sm" onClick={submit} disabled={text.trim() === ''}>
          发送
        </Button>
      )}
    </div>
  )
}
