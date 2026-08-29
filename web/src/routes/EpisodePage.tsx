import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { PanelRightClose, PanelRightOpen, Settings } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PostView } from '@/features/audio-workspace/PostView'
import { ChatStream } from '@/features/writer-chat/ChatStream'
import { Composer } from '@/features/writer-chat/Composer'
import { RunStatusBar } from '@/features/writer-chat/RunStatusBar'
import { useWriterRun } from '@/features/writer-chat/useWriterRun'
import { ScriptLineList } from '@/features/script-panel/ScriptLineList'
import { StagingBar } from '@/features/script-panel/StagingBar'
import { applyOps } from '@/features/script-panel/staging'
import { useEpisode } from '@/hooks/useEpisode'
import { useInvalidatedLineIds } from '@/hooks/useInvalidated'
import { useScript } from '@/hooks/useScript'
import { useWorkspace } from '@/hooks/useWorkspace'
import { apiErrorMessage } from '@/lib/api/http'
import { cn } from '@/lib/utils'
import { useStaging } from '@/stores/staging'
import { useWriterRunStore } from '@/stores/writer-run'

// 编辑页（#30 重构，原上下两半）：左栏「写稿 / 后期」同页视图切换（决策 issue #30），
// 右侧全高侧边栏 = 写稿大师聊天（M3，可收起）。写稿视图 = 脚本行编辑 + 行内联试听；
// 后期视图 = 素材概览 + 停顿/语速参数（M5 补整集合成/Master 播放）。暂存条横跨两视图。
export default function EpisodePage() {
  const { wsId = '', episodeId = '' } = useParams()
  const episode = useEpisode(episodeId)
  const workspace = useWorkspace(wsId)
  const script = useScript(episodeId)
  const writer = useWriterRun(episodeId)
  const running = useWriterRunStore((s) => s.runs[episodeId]?.running ?? false)
  const [chatOpen, setChatOpen] = useState(true)
  const [view, setView] = useState<'write' | 'post'>('write')
  const ops = useStaging((s) => s.buffers[episodeId]?.ops)
  const invalidated = useInvalidatedLineIds(episodeId)

  const speakers = useMemo(() => workspace.data?.speakers ?? [], [workspace.data])

  // 文本投影 = ['script', ep] 缓存叠暂存 ops；提交成功后由 StagingBar 直写缓存
  const lines = useMemo(() => {
    if (!script.data) return []
    return applyOps(script.data.lines, ops ?? [], speakers)
  }, [script.data, ops, speakers])

  // 后期 tab 上的角标：待处理素材行数（未合成或被作废）
  const needsResynthCount = useMemo(
    () => lines.filter((l) => !l.asset.has || invalidated.has(l.id)).length,
    [lines, invalidated],
  )

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
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 左栏视图切换（#30）：两视图各自占满剩余高度 */}
          <div className="flex items-center gap-1 border-b px-3 py-1.5">
            <ViewTab active={view === 'write'} onClick={() => setView('write')}>
              写稿
            </ViewTab>
            <ViewTab active={view === 'post'} onClick={() => setView('post')}>
              后期
              {needsResynthCount > 0 && (
                <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500/15 px-1 text-[10px] font-medium text-amber-600">
                  {needsResynthCount}
                </span>
              )}
            </ViewTab>
          </div>

          <section className="min-h-0 flex-1 overflow-y-auto">
            {script.isPending ? (
              <p className="p-4 text-sm text-muted-foreground">脚本加载中…</p>
            ) : view === 'write' ? (
              <ScriptLineList episodeId={episodeId} lines={lines} speakers={speakers} />
            ) : (
              <PostView episodeId={episodeId} lines={lines} />
            )}
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

function ViewTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'rounded-md px-2.5 py-1 text-sm transition-colors',
        active
          ? 'bg-secondary font-medium text-secondary-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
