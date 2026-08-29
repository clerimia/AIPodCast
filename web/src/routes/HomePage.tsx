import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
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
import { Input } from '@/components/ui/input'
import { useWorkspaces } from '@/hooks/useWorkspace'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { workspaceApi } from '@/lib/api/workspace'
import type { Workspace } from '@/lib/api/types'

// 工作间列表（#20 路由表 /）：列工作间 / 建工作间。
// 工作间卡片点击进入工作间页面（单集列表与建单集在那边，不再堆在卡片里）。
export default function HomePage() {
  const queryClient = useQueryClient()
  const workspaces = useWorkspaces()
  const [name, setName] = useState('')

  const create = useMutation({
    mutationFn: () => workspaceApi.create({ name: name.trim() }),
    onSuccess: () => {
      setName('')
      void queryClient.invalidateQueries({ queryKey: qk.workspaces() })
      toast.success('工作间已创建')
    },
    onError: (e) => toast.error(`创建失败：${apiErrorMessage(e)}`),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() !== '') create.mutate()
  }

  return (
    <div className="mx-auto min-h-svh max-w-4xl space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Podcast Studio</h1>
          <p className="text-sm text-muted-foreground">单用户 AI 播客工作间</p>
        </div>
        <form className="flex items-center gap-2" onSubmit={submit}>
          <Input
            className="w-56"
            placeholder="新工作间名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={name.trim() === '' || create.isPending}>
            {create.isPending ? '创建中…' : '建工作间'}
          </Button>
        </form>
      </header>

      {workspaces.isPending && <p className="text-sm text-muted-foreground">加载中…</p>}
      {workspaces.isError && (
        <Card>
          <CardContent className="flex items-center gap-2 pt-6 text-sm">
            <Badge variant="destructive">加载失败</Badge>
            <span className="text-muted-foreground">{apiErrorMessage(workspaces.error)}</span>
          </CardContent>
        </Card>
      )}
      {workspaces.data && workspaces.data.length === 0 && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            还没有工作间。一个工作间 = 一个节目，先在右上角建一个。
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {workspaces.data?.map((ws) => <WorkspaceCard key={ws.id} ws={ws} />)}
      </div>
    </div>
  )
}

function WorkspaceCard({ ws }: { ws: Workspace }) {
  const navigate = useNavigate()

  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-accent/40"
      onClick={() => navigate(`/workspaces/${ws.id}`)}
    >
      <CardHeader>
        <CardTitle className="text-lg">
          <Link
            to={`/workspaces/${ws.id}`}
            className="hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {ws.name}
          </Link>
        </CardTitle>
        <CardDescription>{new Date(ws.createdAt).toLocaleDateString()} 创建</CardDescription>
        <CardAction>
          <Button asChild variant="ghost" size="sm" onClick={(e) => e.stopPropagation()}>
            <Link to={`/workspaces/${ws.id}/settings`}>设置</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        点卡片进入工作间：列单集、建单集并开始写稿。
      </CardContent>
    </Card>
  )
}
