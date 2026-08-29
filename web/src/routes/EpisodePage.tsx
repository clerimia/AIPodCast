import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { PanelRightClose, PanelRightOpen, Settings } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AudioLineList } from '@/features/audio-workspace/AudioLineList'
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
import { cn } from '@/lib/utils'
import { useStaging } from '@/stores/staging'
import { useWriterRunStore } from '@/stores/writer-run'

// 编辑页（CONTEXT.md：上半区文本编辑、下半区音频工作区，上下各自滚动）。
// 右侧全高侧边栏 = 写稿大师聊天（M3，可收起，收起后不占布局）；左侧上 = 脚本面板、下 = 音频工作区（M4 落地）。
export default function EpisodePage() {
  const { wsId = '', episodeId = '' } = useParams()
  const episode = useEpisode(episodeId)
  const workspace = useWorkspace(wsId)
  const script = useScript(episodeId)
  const writer = useWriterRun(episodeId)
  const running = useWriterRunStore((s) => s.runs[episodeId]?.running ?? false)
  const [chatOpen, setChatOpen] = useState(true)
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
        <div className="ml-auto flex items-center gap-1">
          {chatOpen ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="收起写稿大师侧边栏"
              onClick={() => setChatOpen(false)}
            >
              <PanelRightClose />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              aria-label="打开写稿大师侧边栏"
              onClick={() => setChatOpen(true)}
            >
              <PanelRightOpen />
              写稿大师
              {running && <span className="size-2 animate-pulse rounded-full bg-emerald-500" />}
            </Button>
          )}
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

      <main className="flex min-h-0 flex-1">
        <div className="grid min-h-0 flex-1 grid-rows-2">
          {/* 左上：脚本行面板 */}
          <section className="min-h-0 overflow-y-auto border-b">
            {script.isPending ? (
              <p className="p-4 text-sm text-muted-foreground">脚本加载中…</p>
            ) : (
              <ScriptLineList episodeId={episodeId} lines={lines} speakers={speakers} />
            )}
          </section>

          {/* 左下：音频工作区（M4 落试听/停顿语速；M5 补整集合成/Master 播放） */}
          <section className="min-h-0 overflow-y-auto">
            <AudioLineList episodeId={episodeId} lines={lines} />
          </section>
        </div>

        {/* 右侧全高侧边栏：写稿大师聊天。收起时 hidden（脱离布局）但保持挂载，输入草稿不丢 */}
        <aside className={cn('flex min-h-0 w-[420px] flex-none flex-col border-l', !chatOpen && 'hidden')}>
          <ChatStream episodeId={episodeId} />
          <RunStatusBar episodeId={episodeId} />
          <Composer
            episodeId={episodeId}
            onSend={(text) => void writer.send(text)}
            onStop={() => void writer.stop()}
          />
        </aside>
      </main>

      <StagingBar episodeId={episodeId} />
    </div>
  )
}
