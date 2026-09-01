import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, FileUp, Loader2, Sparkles, Trash2, Type, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { resourceApi } from '@/lib/api/resource'
import type { ResourceSummary } from '@/lib/api/types'
import { PasteDialog } from './PasteDialog'

const ACCEPT = '.md,.markdown,.txt,.docx,.pdf'

const kindLabel: Record<ResourceSummary['kind'], string> = {
  md: 'Markdown',
  txt: '文本',
  docx: 'Word',
  pdf: 'PDF',
  paste: '粘贴',
}

function reportIngest(body: { duplicateTitle: string | null }) {
  if (body.duplicateTitle) toast.info(`注意：工作间已有同内容资源《${body.duplicateTitle}》`)
}

export function ResourceList({ wsId }: { wsId: string }) {
  const queryClient = useQueryClient()
  const uploadInput = useRef<HTMLInputElement>(null)
  const replaceInput = useRef<HTMLInputElement>(null)
  const [replacing, setReplacing] = useState<ResourceSummary | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [deleting, setDeleting] = useState<ResourceSummary | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  // 替换 → 粘贴：单独 dialog，复用 PasteDialog 组件
  const [replacePaste, setReplacePaste] = useState<ResourceSummary | null>(null)

  const { data: resources = [], isPending } = useQuery({
    queryKey: qk.resources(wsId),
    queryFn: () => resourceApi.list(wsId),
  })

  const upload = useMutation({
    mutationFn: (file: File) => resourceApi.upload(wsId, file),
    onSuccess: (body) => {
      void queryClient.invalidateQueries({ queryKey: qk.resources(wsId) })
      reportIngest(body)
      toast.success(`《${body.resource.title}》已入库（${body.chunkCount} 块，未向量化）`)
    },
    onError: (e) => toast.error(`上传失败：${apiErrorMessage(e)}`),
  })

  const replace = useMutation({
    mutationFn: ({ rid, file }: { rid: string; file: File }) => resourceApi.replaceWithFile(wsId, rid, file),
    onSuccess: (body) => {
      void queryClient.invalidateQueries({ queryKey: qk.resources(wsId) })
      reportIngest(body)
      toast.success(`已替换（${body.chunkCount} 块，未向量化）`)
      setReplacing(null)
      setPendingFile(null)
    },
    onError: (e) => {
      toast.error(`替换失败：${apiErrorMessage(e)}`)
      setReplacing(null)
      setPendingFile(null)
    },
  })

  const remove = useMutation({
    mutationFn: (rid: string) => resourceApi.remove(wsId, rid),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.resources(wsId) })
      toast.success('资源已删除')
      setDeleting(null)
    },
    onError: (e) => toast.error(`删除失败：${apiErrorMessage(e)}`),
  })

  const embed = useMutation({
    mutationFn: (rid: string) => resourceApi.embed(wsId, rid),
    onSuccess: (body) => {
      void queryClient.invalidateQueries({ queryKey: qk.resources(wsId) })
      if (body.status === 'done') toast.success(`已向量化（${body.chunkCount} 块）`)
      else if (body.status === 'partial') toast.warning(`部分向量化：${body.failedCount} 个块失败（仍可走全文通道）`)
      else toast.error('向量化失败：全部块未生成向量')
    },
    onError: (e) => toast.error(`向量化失败：${apiErrorMessage(e)}`),
  })

  const busy = upload.isPending || replace.isPending

  return (
    <Card>
      <CardHeader>
        <CardTitle>资源</CardTitle>
        <CardDescription>工作间知识库：上传或粘贴资料，写稿大师检索引用（.md/.txt/.docx/.pdf，≤20MB）</CardDescription>
        <CardAction>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setPasteOpen(true)}>
              粘贴文本
            </Button>
            <Button size="sm" disabled={busy} onClick={() => uploadInput.current?.click()}>
              <Upload />
              {upload.isPending ? '上传中…' : '上传文件'}
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* 上传：选中即提交；替换：选中后进确认对话框（替换不可逆，多一步确认） */}
        <input
          ref={uploadInput}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) upload.mutate(file)
            e.target.value = ''
          }}
        />
        <input
          ref={replaceInput}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file && replacing) setPendingFile(file)
            e.target.value = ''
          }}
        />

        {isPending && <div className="h-24 animate-pulse rounded-xl bg-muted/60" />}

        {!isPending && resources.length === 0 && (
          <EmptyState
            compact
            icon={FileText}
            title="还没有资源"
            description="上传或粘贴资料后，写稿大师涉及事实、数据、背景时会先检索再写。"
          />
        )}

        {!isPending &&
          resources.map((r) => (
            <div
              key={r.id}
              className="flex items-start justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/40"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.title}</span>
                  <Badge variant="outline">{kindLabel[r.kind]}</Badge>
                  <VectorBadge status={r.embeddingStatus} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {new Date(r.createdAt).toLocaleDateString()} · {r.charCount.toLocaleString()} 字 · {r.chunkCount} 块
                  {r.embeddedCount > 0 ? ` · 向量 ${r.embeddedCount}/${r.chunkCount}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={embed.isPending || busy}
                  onClick={() => embed.mutate(r.id)}
                >
                  {embed.isPending && embed.variables === r.id ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Sparkles />
                  )}
                  {embed.isPending && embed.variables === r.id ? '向量化中…' : '向量化'}
                </Button>
                {/* 替换入口：两个等价路径——上传文件 / 粘贴文本——放进同一菜单，避免顶栏多塞按钮 */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" disabled={busy} aria-label={`替换资源《${r.title}》`}>
                      替换
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        setReplacing(r)
                        replaceInput.current?.click()
                      }}
                    >
                      <FileUp /> 上传文件
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setReplacePaste(r)}>
                      <Type /> 粘贴文本
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  disabled={remove.isPending}
                  onClick={() => setDeleting(r)}
                  aria-label={`删除资源《${r.title}》`}
                >
                  <Trash2 />
                  删除
                </Button>
              </div>
            </div>
          ))}
      </CardContent>

      {/* 替换确认：选中文件后二次确认（spec「文件选择后确认」） */}
      <Dialog
        open={replacing !== null && pendingFile !== null}
        onOpenChange={(v) => {
          if (!v) {
            setPendingFile(null)
            setReplacing(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>替换资源</DialogTitle>
            <DialogDescription>
              用「{pendingFile?.name}」替换《{replacing?.title}》？旧内容与切块会被整体换新，不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPendingFile(null)
                setReplacing(null)
              }}
            >
              取消
            </Button>
            <Button
              disabled={replace.isPending}
              onClick={() => replacing && pendingFile && replace.mutate({ rid: replacing.id, file: pendingFile })}
            >
              {replace.isPending ? '替换中…' : '确认替换'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认：级联删块不可逆，多一步确认 */}
      <Dialog open={deleting !== null} onOpenChange={(v) => !v && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>删除资源</DialogTitle>
            <DialogDescription>
              确定删除《{deleting?.title}》？切块与向量会一并删除，写稿大师将检索不到它。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              {remove.isPending ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasteDialog wsId={wsId} open={pasteOpen} onOpenChange={setPasteOpen} mode={{ kind: 'create' }} />
      <PasteDialog
        wsId={wsId}
        open={replacePaste !== null}
        onOpenChange={(v) => !v && setReplacePaste(null)}
        mode={replacePaste ? { kind: 'replace', resourceId: replacePaste.id, initialTitle: replacePaste.title } : { kind: 'create' }}
      />
    </Card>
  )
}

function VectorBadge({ status }: { status: ResourceSummary['embeddingStatus'] }) {
  const map = {
    pending: { label: '未向量化', variant: 'outline' as const },
    partial: { label: '部分向量', variant: 'secondary' as const },
    done: { label: '已向量化', variant: 'default' as const },
  }
  const { label, variant } = map[status]
  return (
    <Badge variant={variant} className="text-xs">
      {label}
    </Badge>
  )
}