import { useMemo } from 'react'
import { Link, useParams } from 'react-router'
import { Settings } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChatStream } from '@/features/writer-chat/ChatStream'
import { Composer } from '@/features/writer-chat/Composer'
import { RunStatusBar } from '@/features/writer-chat/RunStatusBar'
import { useWriterRun } from '@/features/writer-chat/useWriterRun'
import { ScriptLineList } from '@/features/script-panel/ScriptLineList'
import { StagingBar } from '@/features/script-panel/StagingBar'
import { applyOps } from '@/features/script-panel/staging'
import { useEpisode } from '@/hooks/useEpisode'
import { useScript } from '@/hooks/useScript'
import { useWorkspace } from '@/hooks/useWorkspace'
import { apiErrorMessage } from '@/lib/api/http'
import { useStaging } from '@/stores/staging'

// 编辑页（CONTEXT.md：上半区文本编辑、下半区音频工作区，上下各自滚动）。
// 上半区左 = 写稿大师聊天（M3），右 = 脚本面板；下半区音频工作区 M4 落地。
export default function EpisodePage() {
  const { wsId = '', episodeId = '' } = useParams()
  const episode = useEpisode(episodeId)
  const workspace = useWorkspace(wsId)
  const script = useScript(episodeId)
  const writer = useWriterRun(episodeId)
  const ops = useStaging((s) => s.buffers[episodeId]?.ops)

  const speakers = useMemo(() => workspace.data?.speakers ?? [], [workspace.data])

  // 文本投影 = ['script', ep] 缓存叠暂存 ops；提交成功后由 StagingBar 直写缓存
  const lines = useMemo(() => {
    if (!script.data) return []
    return applyOps(script.data.lines, ops ?? [], speakers)
  }, [script.data, ops, speakers])

  return (
    <div className="flex h-svh flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button asChild variant="ghost" size="icon-sm" aria-label="返回工作间页面">
          <Link to={`/workspaces/${wsId}`}>←</Link>
        </Button>
        <h1 className="min-w-0 truncate text-base font-semibold">
          {episode.isPending ? '加载中…' : (episode.data?.title ?? '单集')}
        </h1>
        <Badge variant="secondary">单集</Badge>
        <div className="ml-auto flex items-center">
          <Button asChild variant="ghost" size="sm">
            <Link to={`/workspaces/${wsId}/settings`}>
              <Settings /> 工作间设置
            </Link>
          </Button>
        </div>
      </header>

      {script.isError && (
        <p className="border-b bg-destructive/10 px-4 py-2 text-sm">
          脚本加载失败：{apiErrorMessage(script.error)}
        </p>
      )}

      <main className="grid min-h-0 flex-1 grid-rows-2">
        {/* 上半区：文本侧（左写稿大师聊天 / 右脚本行面板） */}
        <section className="grid min-h-0 grid-cols-2 divide-x border-b">
          <div className="flex min-h-0 flex-col">
            <ChatStream episodeId={episodeId} />
            <RunStatusBar episodeId={episodeId} />
            <Composer
              episodeId={episodeId}
              onSend={(text) => void writer.send(text)}
              onStop={() => void writer.stop()}
            />
          </div>
          <div className="min-h-0 overflow-y-auto">
            {script.isPending ? (
              <p className="p-4 text-sm text-muted-foreground">脚本加载中…</p>
            ) : (
              <ScriptLineList episodeId={episodeId} lines={lines} speakers={speakers} />
            )}
          </div>
        </section>

        {/* 下半区：音频工作区（M4 落试听/停顿语速/整集合成/Master 播放） */}
        <section className="min-h-0 overflow-y-auto">
          <div className="mx-auto max-w-3xl p-4">
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              音频工作区（M4 落地）：单行试听、停顿/语速、整集合成与 master 播放。
            </p>
          </div>
        </section>
      </main>

      <StagingBar episodeId={episodeId} />
    </div>
  )
}
