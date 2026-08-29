// 输入框：run 期间禁用（frontend-structure.md「暂停编辑窗口」）；运行中显示停止按钮
//（POST abort）。Enter 发送、Shift+Enter 换行。
import { useState } from 'react'
import { Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useWriterRunStore } from '@/stores/writer-run'

export function Composer({
  episodeId,
  onSend,
  onStop,
}: {
  episodeId: string
  onSend: (text: string) => void
  onStop: () => void
}) {
  const running = useWriterRunStore((s) => s.runs[episodeId]?.running ?? false)
  const [text, setText] = useState('')

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '' || running) return
    onSend(trimmed)
    setText('')
  }

  return (
    <div className="flex items-end gap-2 border-t p-2">
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
