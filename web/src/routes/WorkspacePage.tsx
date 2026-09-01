import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowLeft, ArrowRight, ListVideo, Loader2, MoreHorizontal, Plus, Settings, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CommandPalette, usePaletteHotkey, type Command } from '@/components/command-palette'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { ThemeToggle } from '@/components/theme-toggle'
import { useEpisodes, useWorkspace } from '@/hooks/useWorkspace'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { workspaceApi } from '@/lib/api/workspace'
import { formatHotkey } from '@/lib/hotkeys'

// 工作间页面（/workspaces/:wsId）：单集列表 + 建单集；从首页卡片或编辑页头部进入。
// 路由决策更新：#20 原为三页面，应用户要求（#25 后）增加工作间层级的落点。
//
// 手感层：建单集表单原来沉在列表最底下——空列表时用户根本看不见它（列表为空 → 页面
// 底部还有一个看不见的输入框）。提到顶部，且空状态时把「先建说话人」这条前置依赖说清。
export default function WorkspacePage() {
  const { wsId = '' } = useParams()
  const workspace = useWorkspace(wsId)
  const episodes = useEpisodes(wsId)
  const navigate = useNavigate()
  const [paletteOpen, setPaletteOpen] = useState(false)

  usePaletteHotkey(() => setPaletteOpen(true))

  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'nav.home',
        group: '导航',
        title: '返回全部工作间',
        icon: ArrowLeft,
        keywords: 'back home 返回 工作间列表',
        run: () => navigate('/'),
      },
      {
        id: 'nav.settings',
        group: '导航',
        title: '工作间设置',
        hint: '节目元数据与说话人',
        icon: Settings,
        keywords: 'settings speaker 设置 说话人',
        run: () => navigate(`/workspaces/${wsId}/settings`),
      },
      {
        id: 'ws.home',
        group: '导航',
        title: '打开命令面板',
        icon: ArrowRight,
        shortcut: formatHotkey('mod+k'),
        keywords: 'palette 命令',
        run: () => setPaletteOpen(true),
      },
    ],
    [navigate, wsId],
  )

  return (
    <div className="mx-auto min-h-svh max-w-4xl px-6 py-8">
      <header className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon-sm" aria-label="返回工作间列表" title="返回工作间列表">
          <Link to="/">
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">
          {workspace.isPending ? '加载中…' : (workspace.data?.name ?? '工作间')}
        </h1>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <Button asChild variant="ghost" size="sm">
            <Link to={`/workspaces/${wsId}/settings`}>
              <Settings /> <span className="hidden sm:inline">工作间设置</span>
            </Link>
          </Button>
        </div>
      </header>

      {workspace.isError && (
        <div className="mt-6">
          <EmptyState title="工作间加载失败" description={apiErrorMessage(workspace.error)} />
        </div>
      )}

      <EpisodeSection wsId={wsId} episodes={episodes.data} pending={episodes.isPending} />

      <CommandPalette commands={commands} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  )
}

function EpisodeSection({
  wsId,
  episodes,
  pending,
}: {
  wsId: string
  episodes?: { id: string; title: string; showNotes: string; createdAt: string; hasArtifact: boolean }[]
  pending: boolean
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  // 二次确认：要求用户输入「删除」字样才能点确定；防止误触
  const [deleting, setDeleting] = useState<{ id: string; title: string; hasArtifact: boolean } | null>(null)
  const [confirmText, setConfirmText] = useState('')

  // 建单集后直接进入编辑页（与原首页卡片行为一致）
  const createEpisode = useMutation({
    mutationFn: () => workspaceApi.createEpisode(wsId, { title: title.trim() }),
    onSuccess: (ep) => {
      setTitle('')
      void queryClient.invalidateQueries({ queryKey: qk.episodes(wsId) })
      navigate(`/workspaces/${wsId}/episodes/${ep.id}`)
    },
    onError: (e) => toast.error(`建单集失败：${apiErrorMessage(e)}`),
  })

  // 硬删单集。后端总是 204；前端 cancel 清理 confirm 文本
  const removeEpisode = useMutation({
    mutationFn: (eid: string) => workspaceApi.deleteEpisode(wsId, eid),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.episodes(wsId) })
      toast.success('单集已删除')
      setDeleting(null)
      setConfirmText('')
    },
    onError: (e) => toast.error(`删除失败：${apiErrorMessage(e)}`),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (title.trim() !== '') createEpisode.mutate()
  }

  return (
    <section className="mt-8 space-y-3">
      {/* 建单集提到列表上方：空列表时也能一眼看到入口 */}
      <form className="flex items-center gap-2" onSubmit={submit}>
        <Input
          className="max-w-64"
          placeholder="新单集标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button type="submit" disabled={title.trim() === '' || createEpisode.isPending}>
          <Plus />
          {createEpisode.isPending ? '创建中…' : '建单集'}
        </Button>
      </form>

      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">单集</h2>
        <Badge variant="secondary">{episodes?.length ?? 0}</Badge>
      </div>

      {pending && (
        <div className="space-y-1.5">
          {[0, 1].map((i) => (
            <div key={i} className="h-11 animate-pulse rounded-lg bg-muted/60" />
          ))}
        </div>
      )}

      {episodes && episodes.length === 0 && (
        <EmptyState
          compact
          icon={ListVideo}
          title="还没有单集"
          description="一个单集 = 一份脚本 + 一份产物。从上面建一个，进去就能让写稿大师起稿。"
        />
      )}

      <ul className="space-y-1">
        {episodes?.map((ep) => (
          <li key={ep.id} className="group relative flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-all hover:border-brand-border hover:bg-brand-soft">
            <Link to={`/workspaces/${wsId}/episodes/${ep.id}`} className="flex min-w-0 flex-1 items-center gap-3">
              <span className="min-w-0 flex-1 truncate font-medium">{ep.title}</span>
              {ep.hasArtifact && <Badge variant="secondary">有产物</Badge>}
              <span className="shrink-0 text-xs text-muted-foreground">
                {new Date(ep.createdAt).toLocaleDateString()}
              </span>
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
            {/* 行尾操作：单个 DropdownMenu 不挤排版；只放删除（删除不可逆） */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`单集《${ep.title}》操作`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    setDeleting({ id: ep.id, title: ep.title, hasArtifact: ep.hasArtifact })
                    setConfirmText('')
                  }}
                >
                  <Trash2 /> 删除单集
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>

      {/* 硬删二次确认：需手动输入「删除」字样才能点确定（防误触）；有产物时再额外提醒 */}
      <Dialog
        open={deleting !== null}
        onOpenChange={(v) => {
          if (!v) {
            setDeleting(null)
            setConfirmText('')
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>删除单集《{deleting?.title}》</DialogTitle>
            <DialogDescription>
              {deleting?.hasArtifact
                ? '⚠️ 该单集已有产物（master.mp3 / 行级文稿 / 单集简介），一并删除。脚本、素材与会话历史也会清空。'
                : '脚本、素材与会话历史会全部清空，不可恢复。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="episode-delete-confirm" className="text-sm font-medium">
              输入「<span className="text-destructive">删除</span>」以确认
            </label>
            <Input
              id="episode-delete-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="删除"
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleting(null)
                setConfirmText('')
              }}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={confirmText !== '删除' || removeEpisode.isPending}
              onClick={() => deleting && removeEpisode.mutate(deleting.id)}
            >
              {removeEpisode.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {removeEpisode.isPending ? '删除中…' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
