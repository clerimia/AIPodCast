import { useEffect, useRef, useState } from 'react'
import { Loader2, Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatClock } from '@/lib/format'
import { cn } from '@/lib/utils'

// 行内联试听播放器：取代浏览器原生 <audio controls>——原生控件在各浏览器里样式各异，
// 在只有 32px 高的脚本行里会压成一条看不清的灰条。这里只保留试听真正需要的三件事：
// 播放/暂停、进度（可点选跳转）、时长。
// playToken 每次 preview 成功自增：force 重生成是同 URL 覆盖，靠它强制重取重播。

export function LineAudioPlayer({
  src,
  playToken,
  className,
}: {
  src: string
  /** 每次试听成功自增：>0 时自动播放（用户点 ▶ 后的程序化播放属合法手势） */
  playToken: number
  className?: string
}) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [current, setCurrent] = useState(0)
  const [prevSrc, setPrevSrc] = useState(src)

  // 换一行试听（src 变化）时重置时间轴：用渲染期对比上一值，避免 effect 里 setState
  // 多触发一轮渲染
  if (prevSrc !== src) {
    setPrevSrc(src)
    setCurrent(0)
    setDuration(0)
  }

  // 试听成功即自动播放；被浏览器策略拒绝时用户点一下播放键仍可播
  useEffect(() => {
    const el = audioRef.current
    if (playToken === 0 || !el) return
    el.load()
    void el.play().catch(() => {})
  }, [playToken, src])

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) void el.play().catch(() => {})
    else el.pause()
  }

  const seek = (event: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current
    if (!el || duration === 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
    el.currentTime = ratio * duration
    setCurrent(el.currentTime)
  }

  const progress = duration > 0 ? (current / duration) * 100 : 0

  return (
    <div
      className={cn(
        'mt-1.5 flex items-center gap-2 rounded-md bg-muted/60 px-1.5 py-1',
        className,
      )}
    >
      <audio
        ref={audioRef}
        preload="metadata"
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        className="hidden"
      />
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={playing ? '暂停' : '播放'}
        className="shrink-0 rounded-full"
        onClick={toggle}
      >
        {playing ? <Pause className="size-3 fill-current" /> : <Play className="size-3 fill-current" />}
      </Button>

      {/* 进度条：点击/拖拽定位。用 div 而非 <input range>，视觉与行高更好对齐 */}
      <div
        role="slider"
        tabIndex={0}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        onMouseDown={seek}
        onKeyDown={(e) => {
          const el = audioRef.current
          if (!el) return
          if (e.key === 'ArrowRight') el.currentTime = Math.min(el.currentTime + 5, duration || 0)
          if (e.key === 'ArrowLeft') el.currentTime = Math.max(el.currentTime - 5, 0)
        }}
        className="group/track relative h-1.5 min-w-0 flex-1 cursor-pointer rounded-full bg-foreground/10"
      >
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-100"
          style={{ width: `${progress}%` }}
        />
        <span
          className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand opacity-0 transition-opacity group-hover/track:opacity-100"
          style={{ left: `${progress}%` }}
        />
      </div>

      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {formatClock(current * 1000)} / {formatClock(duration * 1000)}
      </span>
      {playToken > 0 && duration === 0 && <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />}
    </div>
  )
}
