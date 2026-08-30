import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  ChevronRight,
  Command as CommandIcon,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Settings,
  Sparkles,
  SlidersHorizontal,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CommandPalette, usePaletteHotkey, type Command } from '@/components/command-palette'
import { Kbd } from '@/components/ui/kbd'
import { Segmented } from '@/components/ui/segmented'
import { ThemeToggle } from '@/components/theme-toggle'
import { PostView } from '@/features/audio-workspace/PostView'
import { useIsSynthesizing, useStartSynthesis } from '@/features/audio-workspace/use-start-synthesis'
import { ChatStream } from '@/features/writer-chat/ChatStream'
import { Composer, loadThinkingPreference } from '@/features/writer-chat/Composer'
import { RunStatusBar } from '@/features/writer-chat/RunStatusBar'
import { useWriterRun } from '@/features/writer-chat/useWriterRun'
import { ScriptLineList } from '@/features/script-panel/ScriptLineList'
import { StagingBar } from '@/features/script-panel/StagingBar'
import { useCommitStaged } from '@/features/script-panel/use-commit-staged'
import { applyOps } from '@/features/script-panel/staging'
import { useEpisode } from '@/hooks/useEpisode'
import { useHotkey } from '@/hooks/use-hotkey'
import { useInvalidatedLineIds } from '@/hooks/useInvalidated'
import { usePersistentState } from '@/hooks/use-persistent-state'
import { useScript } from '@/hooks/useScript'
import { useWorkspace } from '@/hooks/useWorkspace'
import { apiErrorMessage } from '@/lib/api/http'
import { formatHotkey } from '@/lib/hotkeys'
import { cn } from '@/lib/utils'
import { useStaging } from '@/stores/staging'
import { useWriterRunStore } from '@/stores/writer-run'

// 编辑页（#30 重构，原上下两半）：左栏「写稿 / 后期」同页视图切换，右侧全高侧边栏 =
// 写稿大师聊天。写稿视图 = 脚本行编辑 + 行内联试听；后期视图 = 素材概览 + 停顿/语速参数
// + 整集合成。暂存条横跨两视图。
//
// 手感层（本轮 UI/UX 升级）：
// - 头部面包屑（工作间 / 单集）+ 命令面板入口 + 主题切换，四处导航收敛成一条头部；
// - 视图切换改分段控件（当前态一眼可辨），带待合成行数角标；
// - 侧栏可拖宽（宽窄持久化），双击分隔条复位；写稿时想看宽一点、改稿时想让稿子宽一点都能满足；
// - ⌘K 命令面板 + 一组快捷键，键盘走查不依赖鼠标。
const CHAT_WIDTH_DEFAULT = 420
const CHAT_WIDTH_MIN = 320
/** 左栏至少留这么宽，否则脚本行会被挤到不可读 */
const LEFT_PANE_MIN = 420

export default function EpisodePage() {
  const { wsId = '', episodeId = '' } = useParams()
  const navigate = useNavigate()
  const episode = useEpisode(episodeId)
  const workspace = useWorkspace(wsId)
  const script = useScript(episodeId)
  const writer = useWriterRun(episodeId)
  const running = useWriterRunStore((s) => s.runs[episodeId]?.running ?? false)
  const [view, setView] = useState<'write' | 'post'>('write')
  const ops = useStaging((s) => s.buffers[episodeId]?.ops)
  const invalidated = useInvalidatedLineIds(episodeId)

  const [chatOpen, setChatOpen] = usePersistentState('episode.chatOpen', true)
  const [chatWidth, setChatWidth] = usePersistentState('episode.chatWidth', CHAT_WIDTH_DEFAULT)
  const [dragging, setDragging] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // 由 Composer 注册的聚焦动作（组件自己最清楚焦点该落在哪）
  const focusComposerRef = useRef<(() => void) | null>(null)
  const registerFocusComposer = useCallback((focus: (() => void) | null) => {
    focusComposerRef.current = focus
  }, [])

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

  const { commit, blocker, clearAll } = useCommitStaged(episodeId)
  const startSynthesis = useStartSynthesis(episodeId, lines)
  const isSynthesizing = useIsSynthesizing(episodeId)

  // ---- 快捷键 ----
  usePaletteHotkey(() => setPaletteOpen(true))
  useHotkey('mod+1', () => setView('write'))
  useHotkey('mod+2', () => setView('post'))
  useHotkey('mod+/', () => setChatOpen((open) => !open))
  useHotkey('mod+i', (e) => {
    e.preventDefault()
    if (!chatOpen) setChatOpen(true)
    // 面板本轮才打开时输入框还没挂载，等一帧再聚焦
    requestAnimationFrame(() => focusComposerRef.current?.())
  })
  useHotkey('mod+enter', () => {
    if ((ops?.length ?? 0) > 0 && blocker === null) commit()
  })

  // 拖拽调宽期间：整页锁定 col-resize 光标并禁选中，避免拖出文本选区
  useEffect(() => {
    if (!dragging) return
    const { body } = document
    const prevCursor = body.style.cursor
    const prevSelect = body.style.userSelect
    body.style.cursor = 'col-resize'
    body.style.userSelect = 'none'
    return () => {
      body.style.cursor = prevCursor
      body.style.userSelect = prevSelect
    }
  }, [dragging])

  const clampWidth = (width: number) => {
    const max = Math.max(CHAT_WIDTH_MIN, window.innerWidth - LEFT_PANE_MIN)
    return Math.min(Math.max(width, CHAT_WIDTH_MIN), Math.min(760, max))
  }

  const onDividerPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }
  const onDividerPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setChatWidth(clampWidth(window.innerWidth - e.clientX))
  }
  const onDividerPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
  }

  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'view.write',
        group: '视图',
        title: '写稿视图',
        hint: '编辑台词与指令',
        icon: PenLine,
        keywords: 'write script 脚本 台词',
        shortcut: formatHotkey('mod+1'),
        disabled: view === 'write',
        run: () => setView('write'),
      },
      {
        id: 'view.post',
        group: '视图',
        title: '后期视图',
        hint: needsResynthCount > 0 ? `${needsResynthCount} 行待合成` : '停顿 / 语速 / 合成',
        icon: SlidersHorizontal,
        keywords: 'post audio 音频 合成 参数',
        shortcut: formatHotkey('mod+2'),
        disabled: view === 'post',
        run: () => setView('post'),
      },
      {
        id: 'panel.toggle',
        group: '面板',
        title: chatOpen ? '收起写稿大师' : '展开写稿大师',
        icon: chatOpen ? PanelRightClose : PanelRightOpen,
        keywords: 'chat writer 侧边栏 聊天',
        shortcut: formatHotkey('mod+/'),
        run: () => setChatOpen((open) => !open),
      },
      {
        id: 'panel.focus',
        group: '面板',
        title: '聚焦输入框',
        hint: '直接开写',
        icon: Sparkles,
        keywords: 'focus composer 输入',
        shortcut: formatHotkey('mod+i'),
        run: () => {
          setChatOpen(true)
          requestAnimationFrame(() => focusComposerRef.current?.())
        },
      },
      {
        id: 'script.commit',
        group: '改动',
        title:
          (ops?.length ?? 0) > 0
            ? `提交 ${ops?.length} 处暂存改动`
            : '提交暂存改动（无待提交）',
        hint: blocker ?? '写进库里，素材随之作废',
        keywords: 'commit save 提交 保存',
        shortcut: formatHotkey('mod+enter'),
        disabled: (ops?.length ?? 0) === 0 || blocker !== null,
        run: () => commit(),
      },
      {
        id: 'script.discard',
        group: '改动',
        title: '撤销全部暂存改动',
        hint: '回到服务器上的稿子',
        keywords: 'discard revert 撤销 放弃',
        danger: true,
        disabled: (ops?.length ?? 0) === 0,
        run: clearAll,
      },
      {
        id: 'synth.start',
        group: '合成',
        title: isSynthesizing ? '整集合成进行中…' : '发起整集合成',
        hint: `${lines.length} 行 → master.mp3`,
        icon: Sparkles,
        keywords: 'synthesize tts 合成 生成 音频',
        disabled: lines.length === 0 || isSynthesizing,
        run: () => {
          setView('post')
          void startSynthesis()
        },
      },
      {
        id: 'nav.workspace',
        group: '导航',
        title: '返回工作间',
        hint: workspace.data?.name ?? '单集列表',
        icon: ChevronRight,
        keywords: 'back home 返回 单集',
        run: () => navigate(`/workspaces/${wsId}`),
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
    ],
    [
      navigate,
      view,
      needsResynthCount,
      chatOpen,
      setChatOpen,
      ops?.length,
      blocker,
      commit,
      clearAll,
      isSynthesizing,
      lines.length,
      startSynthesis,
      wsId,
      workspace.data?.name,
    ],
  )

  return (
    <div className="flex h-svh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <Button asChild variant="ghost" size="icon-sm" aria-label="返回工作间页面" title="返回工作间">
          <Link to={`/workspaces/${wsId}`}>
            <ChevronRight className="rotate-180" />
          </Link>
        </Button>

        {/* 面包屑：工作间 / 单集，窄屏只留单集标题（导航层级不靠猜） */}
        <nav aria-label="面包屑" className="flex min-w-0 items-center gap-1 text-sm">
          <Link
            to={`/workspaces/${wsId}`}
            className="hidden max-w-40 truncate text-muted-foreground transition-colors hover:text-foreground sm:block"
          >
            {workspace.isPending ? '…' : (workspace.data?.name ?? '工作间')}
          </Link>
          <ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground/60 sm:block" />
          <span className="min-w-0 truncate font-medium">
            {episode.isPending ? '加载中…' : (episode.data?.title ?? '单集')}
          </span>
        </nav>
        <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
          单集
        </Badge>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            title="命令面板"
            className="mr-0.5 hidden items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:flex"
          >
            <CommandIcon className="size-3.5" />
            命令
            <Kbd>{formatHotkey('mod+k')}</Kbd>
          </button>
          <ThemeToggle />

          <span className="mx-1 hidden h-5 w-px bg-border sm:block" />

          {chatOpen ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="收起写稿大师侧边栏"
              title={`收起写稿大师（${formatHotkey('mod+/')}）`}
              onClick={() => setChatOpen(false)}
            >
              <PanelRightClose />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              aria-label="打开写稿大师侧边栏"
              title={`打开写稿大师（${formatHotkey('mod+/')}）`}
              onClick={() => setChatOpen(true)}
            >
              <PanelRightOpen />
              <span className="hidden lg:inline">写稿大师</span>
              {running && <span className="size-1.5 animate-breathe rounded-full bg-brand" />}
            </Button>
          )}
          <Button asChild variant="ghost" size="icon-sm" title="工作间设置">
            <Link to={`/workspaces/${wsId}/settings`} aria-label="工作间设置">
              <Settings />
            </Link>
          </Button>
        </div>
      </header>

      {script.isError && (
        <p className="shrink-0 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
          脚本加载失败：{apiErrorMessage(script.error)}
        </p>
      )}

      <main className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 左栏视图切换（#30）：两视图各自占满剩余高度。右侧给「谁在动」的即时状态 */}
          <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
            <Segmented
              ariaLabel="左栏视图"
              value={view}
              onChange={setView}
              options={[
                { value: 'write', label: '写稿', icon: PenLine },
                { value: 'post', label: '后期', icon: SlidersHorizontal, badge: needsResynthCount },
              ]}
            />
            <div className="ml-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {running && (
                <span className="flex items-center gap-1.5 truncate text-brand">
                  <span className="size-1.5 animate-breathe rounded-full bg-brand" />
                  <span className="hidden sm:inline">写稿大师正在写…</span>
                </span>
              )}
              {isSynthesizing && (
                <span className="flex items-center gap-1.5 truncate text-brand">
                  <span className="size-1.5 animate-breathe rounded-full bg-brand" />
                  <span className="hidden sm:inline">合成中…</span>
                </span>
              )}
              {!script.isPending && (
                <span className="shrink-0 tabular-nums">{lines.length} 行</span>
              )}
            </div>
          </div>

          <section className="scrollbar-slim min-h-0 flex-1 overflow-y-auto">
            {script.isPending ? (
              <p className="p-4 text-sm text-muted-foreground">脚本加载中…</p>
            ) : view === 'write' ? (
              <ScriptLineList episodeId={episodeId} lines={lines} speakers={speakers} />
            ) : (
              <PostView episodeId={episodeId} lines={lines} />
            )}
          </section>
        </div>

        {/* 拖拽调宽分隔条：双击复位到默认宽度 */}
        {chatOpen && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整写稿大师面板宽度"
            tabIndex={-1}
            data-dragging={dragging}
            onPointerDown={onDividerPointerDown}
            onPointerMove={onDividerPointerMove}
            onPointerUp={onDividerPointerUp}
            onDoubleClick={() => setChatWidth(CHAT_WIDTH_DEFAULT)}
            className={cn(
              'w-1 shrink-0 cursor-col-resize transition-colors',
              dragging ? 'bg-brand' : 'bg-transparent hover:bg-brand/40',
            )}
          />
        )}

        {/* 右侧全高侧边栏：写稿大师聊天。收起时 hidden（脱离布局）但保持挂载，输入草稿不丢 */}
        <aside
          style={chatOpen ? { width: chatWidth } : undefined}
          className={cn(
            'min-h-0 flex-none flex-col border-l',
            chatOpen ? 'flex' : 'hidden',
            dragging && 'pointer-events-none',
          )}
        >
          <ChatStream
            episodeId={episodeId}
            onSuggest={(text) => void writer.send(text, loadThinkingPreference())}
          />
          <RunStatusBar episodeId={episodeId} />
          <Composer
            episodeId={episodeId}
            registerFocus={registerFocusComposer}
            onSend={(text, thinking) => void writer.send(text, thinking)}
            onStop={() => void writer.stop()}
          />
        </aside>
      </main>

      <StagingBar episodeId={episodeId} />
      <CommandPalette commands={commands} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  )
}
