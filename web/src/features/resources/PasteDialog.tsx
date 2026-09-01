import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { resourceApi } from '@/lib/api/resource'

const MAX_PASTE_CHARS = 200_000

// 两种模式：create（持久化为新资源） / replace（替换已有资源；标题缺省沿用）。
// 单组件双形态：避免复制对话框；模式差异只有提交函数与初始标题。
export type PasteDialogMode =
  | { kind: 'create' }
  | { kind: 'replace'; resourceId: string; initialTitle: string }

export function PasteDialog({
  wsId,
  open,
  onOpenChange,
  mode,
}: {
  wsId: string
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: PasteDialogMode
}) {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')

  // 打开时重置；replace 模式预填原标题（用户可改；空 = 沿用原标题）
  useEffect(() => {
    if (open) {
      setText('')
      setTitle(mode.kind === 'replace' ? mode.initialTitle : '')
    }
  }, [open, mode])

  const isReplace = mode.kind === 'replace'

  const submit = useMutation({
    mutationFn: () => {
      if (mode.kind === 'create') {
        return resourceApi.paste(wsId, { title: title.trim(), text })
      }
      // replace：title 空串 = 后端沿用原标题（routes.ts: 缺省 = 沿用）
      return resourceApi.replaceWithText(wsId, mode.resourceId, {
        title: title.trim() === '' ? undefined : title.trim(),
        text,
      })
    },
    onSuccess: (body) => {
      void queryClient.invalidateQueries({ queryKey: qk.resources(wsId) })
      if (body.duplicateTitle) toast.info(`注意：工作间已有同内容资源《${body.duplicateTitle}》`)
      toast.success(isReplace ? '已替换（未向量化）' : '资源已入库（未向量化，在列表点「向量化」）')
      onOpenChange(false)
    },
    onError: (e) => toast.error(`${isReplace ? '替换' : '入库'}失败：${apiErrorMessage(e)}`),
  })

  const valid = text.trim() !== '' && text.length <= MAX_PASTE_CHARS && !submit.isPending
  // create 模式必须填标题；replace 模式标题可空（沿用原标题）
  const titleValid = isReplace || title.trim() !== ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isReplace ? '粘贴文本替换资源' : '粘贴文本建资源'}</DialogTitle>
          <DialogDescription>
            {isReplace
              ? '用粘贴的文本替换原资源；旧内容与切块会整体换新，不可恢复。留空标题 = 沿用原标题。'
              : `持久化为工作间资源：切块、向量化后可被写稿大师检索引用。上限 ${MAX_PASTE_CHARS.toLocaleString()} 字符。`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="paste-title">标题{isReplace ? '（可空）' : ''}</Label>
            <Input
              id="paste-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isReplace ? '留空沿用原标题' : '例如：行业报告摘要'}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="paste-text">正文</Label>
            <Textarea
              id="paste-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder="粘贴正文…（支持 markdown）"
            />
            <p className="text-xs text-muted-foreground">
              {text.length.toLocaleString()} / {MAX_PASTE_CHARS.toLocaleString()}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!valid || !titleValid} onClick={() => submit.mutate()}>
            {submit.isPending ? (isReplace ? '替换中…' : '入库中…') : isReplace ? '替换' : '入库'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
