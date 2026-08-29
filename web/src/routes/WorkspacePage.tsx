import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowLeft, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEpisodes, useWorkspace } from '@/hooks/useWorkspace'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { workspaceApi } from '@/lib/api/workspace'

// 工作间页面（/workspaces/:wsId）：单集列表 + 建单集；从首页卡片或编辑页头部进入。
// 路由决策更新：#20 原为三页面，应用户要求（#25 后）增加工作间层级的落点。
export default function WorkspacePage() {
  const { wsId = '' } = useParams()
  const workspace = useWorkspace(wsId)
  const episodes = useEpisodes(wsId)

  return (
    <div className="mx-auto min-h-svh max-w-4xl space-y-6 p-6">
      <header className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon-sm" aria-label="返回工作间列表">
          <Link to="/">
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="min-w-0 truncate text-2xl font-semibold">
          {workspace.isPending ? '加载中…' : (workspace.data?.name ?? '工作间')}
        </h1>
        <div className="ml-auto flex items-center">
          <Button asChild variant="ghost" size="sm">
            <Link to={`/workspaces/${wsId}/settings`}>
              <Settings /> 工作间设置
            </Link>
          </Button>
        </div>
      </header>

      <EpisodeSection wsId={wsId} episodes={episodes.data} pending={episodes.isPending} />
    </div>
  )
}

function EpisodeSection({
  wsId,
  episodes,
  pending,
}: {
  wsId: string
  episodes?: { id: string; title: string; showNotes: string; createdAt: string }[]
  pending: boolean
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')

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

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (title.trim() !== '') createEpisode.mutate()
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-medium">单集</h2>
        <Badge variant="secondary">{episodes?.length ?? 0}</Badge>
      </div>

      {pending && <p className="text-sm text-muted-foreground">单集加载中…</p>}
      {episodes && episodes.length === 0 && (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          还没有单集。一个单集 = 一份脚本 + 一份产物，从下面建一个开始。
        </p>
      )}
      <ul className="space-y-1">
        {episodes?.map((ep) => (
          <li key={ep.id}>
            <Link
              to={`/workspaces/${wsId}/episodes/${ep.id}`}
              className="block rounded-lg border px-3 py-2 transition-colors hover:bg-accent"
            >
              <span className="font-medium">{ep.title}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {new Date(ep.createdAt).toLocaleDateString()} 创建
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <form className="flex items-center gap-2" onSubmit={submit}>
        <Input
          className="w-64"
          placeholder="新单集标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button
          type="submit"
          disabled={title.trim() === '' || createEpisode.isPending}
        >
          {createEpisode.isPending ? '创建中…' : '建单集'}
        </Button>
      </form>
    </section>
  )
}
