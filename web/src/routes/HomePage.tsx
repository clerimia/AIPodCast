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
import { useEpisodes, useWorkspaces } from '@/hooks/useWorkspace'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { workspaceApi } from '@/lib/api/workspace'
import type { Workspace } from '@/lib/api/types'

// 工作间列表（#20 路由表 /）：列工作间 / 建工作间 / 建单集并进入。
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
  const queryClient = useQueryClient()
  const episodes = useEpisodes(ws.id)
  const [title, setTitle] = useState('')

  // 建单集并直接进入编辑页（M1 收尾链路的最后一跳）
  const createEpisode = useMutation({
    mutationFn: () => workspaceApi.createEpisode(ws.id, { title: title.trim() }),
    onSuccess: (ep) => {
      setTitle('')
      void queryClient.invalidateQueries({ queryKey: qk.episodes(ws.id) })
      navigate(`/workspaces/${ws.id}/episodes/${ep.id}`)
    },
    onError: (e) => toast.error(`建单集失败：${apiErrorMessage(e)}`),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (title.trim() !== '') createEpisode.mutate()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{ws.name}</CardTitle>
        <CardDescription>{new Date(ws.createdAt).toLocaleDateString()} 创建</CardDescription>
        <CardAction>
          <Button asChild variant="ghost" size="sm">
            <Link to={`/workspaces/${ws.id}/settings`}>设置</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {episodes.isPending && <p className="text-sm text-muted-foreground">单集加载中…</p>}
        {episodes.data && episodes.data.length === 0 && (
          <p className="text-sm text-muted-foreground">还没有单集。</p>
        )}
        <ul className="space-y-1">
          {episodes.data?.map((ep) => (
            <li key={ep.id}>
              <Link
                to={`/workspaces/${ws.id}/episodes/${ep.id}`}
                className="block rounded-md px-2 py-1 text-sm hover:bg-accent"
              >
                {ep.title}
              </Link>
            </li>
          ))}
        </ul>
        <form className="flex items-center gap-2" onSubmit={submit}>
          <Input
            className="h-8 w-full"
            placeholder="新单集标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={title.trim() === '' || createEpisode.isPending}
          >
            {createEpisode.isPending ? '创建中…' : '建单集'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
