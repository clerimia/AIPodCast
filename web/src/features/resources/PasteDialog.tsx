import { useState } from 'react'
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

export function PasteDialog({ wsId, open, onOpenChange }: { wsId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')

  const submit = useMutation({
    mutationFn: () => resourceApi.paste(wsId, { title: title.trim(), text }),
    onSuccess: (body) => {
      void queryClient.invalidateQueries({ queryKey: qk.resources(wsId) })
      if (body.duplicateTitle) toast.info(`注意：工作间已有同内容资源《${body.duplicateTitle}》`)
      toast.success('资源已入库（未向量化，在列表点「向量化」）')
      setTitle('')
      setText('')
      onOpenChange(false)
    },
    onError: (e) => toast.error(`入库失败：${apiErrorMessage(e)}`),
  })

  const valid = title.trim() !== '' && text.trim() !== '' && text.length <= MAX_PASTE_CHARS

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>粘贴文本建资源</DialogTitle>
          <DialogDescription>
            持久化为工作间资源：切块、向量化后可被写稿大师检索引用。上限 {MAX_PASTE_CHARS.toLocaleString()} 字符。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="paste-title">标题</Label>
            <Input id="paste-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：行业报告摘要" />
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
          <Button disabled={!valid || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? '入库中…' : '入库'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}