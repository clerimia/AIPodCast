import { useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { ArrowRight, AudioLines, FolderPlus, Settings, Sun, Moon } from 'lucide-react'
import { toast } from 'sonner'
import { useTheme } from 'next-themes'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { CommandPalette, usePaletteHotkey, type Command } from '@/components/command-palette'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { ThemeToggle } from '@/components/theme-toggle'
import { useWorkspaces } from '@/hooks/useWorkspace'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { workspaceApi } from '@/lib/api/workspace'
import { formatHotkey } from '@/lib/hotkeys'
import type { Workspace } from '@/lib/api/types'

// 工作间列表（#20 路由表 /）：列工作间 / 建工作间。
// 工作间卡片点击进入工作间页面（单集列表与建单集在那边，不再堆在卡片里）。
//
// 手感层：这是每次打开的第一个画面，之前是「标题 + 输入框 + 一堆灰卡片」，没有任何
// 品牌感也没有加载/空/错误三态的区分。现在给标题区一枚品牌色标识、加载用骨架卡、
// 空状态给出「一个工作间 = 一个节目」的解释，并接上 ⌘K。
export default function HomePage() {
  const queryClient = useQueryClient()
  const workspaces = useWorkspaces()
  const navigate = useNavigate()
  const { setTheme } = useTheme()
  const [name, setName] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const create = useMutation({
    mutationFn: () => workspaceApi.create({ name: name.trim() }),
    onSuccess: (ws) => {
      setName('')
      void queryClient.invalidateQueries({ queryKey: qk.workspaces() })
      toast.success('工作间已创建', { description: '下一步：建说话人，然后建单集开始写稿' })
      navigate(`/workspaces/${ws.id}`)
    },
    onError: (e) => toast.error(`创建失败：${apiErrorMessage(e)}`),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() !== '') create.mutate()
  }

  usePaletteHotkey(() => setPaletteOpen(true))

  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'ws.create',
        group: '工作间',
        title: '新建工作间',
        hint: '聚焦名称输入框',
        icon: FolderPlus,
        keywords: 'new create 新建 创建',
        shortcut: formatHotkey('mod+k'),
        run: () => nameInputRef.current?.focus(),
      },
      {
        id: 'theme.light',
        group: '主题',
        title: '切换到亮色',
        icon: Sun,
        keywords: 'theme light 亮色 白天',
        run: () => setTheme('light'),
      },
      {
        id: 'theme.dark',
        group: '主题',
        title: '切换到暗色',
        icon: Moon,
        keywords: 'theme dark 暗色 深色 夜间',
        run: () => setTheme('dark'),
      },
    ],
    [setTheme],
  )

  return (
    <div className="mx-auto min-h-svh max-w-5xl px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-brand text-brand-foreground">
            <AudioLines className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Podcast Studio</h1>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <form className="flex items-center gap-2" onSubmit={submit}>
            <Input
              ref={nameInputRef}
              className="w-48 sm:w-56"
              placeholder="新工作间名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" disabled={name.trim() === '' || create.isPending}>
              {create.isPending ? '创建中…' : '建工作间'}
            </Button>
          </form>
        </div>
      </header>

      <div className="mt-8">
        {workspaces.isPending && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-xl bg-muted/60" />
            ))}
          </div>
        )}

        {workspaces.isError && (
          <EmptyState
            title="工作间加载失败"
            description={apiErrorMessage(workspaces.error)}
            action={
              <Button size="sm" variant="outline" onClick={() => void workspaces.refetch()}>
                重试
              </Button>
            }
          />
        )}

        {workspaces.data && workspaces.data.length === 0 && (
          <EmptyState
            icon={FolderPlus}
            title="还没有工作间"
            description="一个工作间 = 一个节目：它有自己的说话人、节目风格与全部单集。先在右上角建一个。"
            action={
              <Button size="sm" onClick={() => nameInputRef.current?.focus()}>
                建第一个工作间
              </Button>
            }
          />
        )}

        {workspaces.data && workspaces.data.length > 0 && (
          <>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-medium">工作间</h2>
              <Badge variant="secondary">{workspaces.data.length}</Badge>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {workspaces.data.map((ws) => (
                <WorkspaceCard key={ws.id} ws={ws} />
              ))}
            </div>
          </>
        )}
      </div>

      <CommandPalette commands={commands} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  )
}

function WorkspaceCard({ ws }: { ws: Workspace }) {
  const navigate = useNavigate()
  const initial = ws.name.trim().charAt(0).toUpperCase() || '·'

  return (
    <Card
      className="group cursor-pointer transition-all hover:border-brand-border hover:shadow-md"
      onClick={() => navigate(`/workspaces/${ws.id}`)}
    >
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-sm font-semibold text-brand">
            {initial}
          </span>
          <span className="min-w-0 truncate">{ws.name}</span>
        </CardTitle>
        <CardDescription>{new Date(ws.createdAt).toLocaleDateString()} 创建</CardDescription>
        <CardAction>
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            aria-label={`${ws.name} 的工作间设置`}
            onClick={(e) => e.stopPropagation()}
          >
            <Link to={`/workspaces/${ws.id}/settings`}>
              <Settings />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex items-center gap-1.5 text-sm text-muted-foreground">
        列单集、建单集并开始写稿
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </CardContent>
    </Card>
  )
}
