import { useEffect, useRef, useState } from 'react'
import { AudioLines, FileText } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { transcriptEntryAt } from '@/features/audio-workspace/transcript'
import { formatBytes, formatClock } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Artifact, ScriptLine } from '@/lib/api/types'

// MasterPlayer（M5，#28）：后处理产物播放器。<audio> + timeupdate 驱动 transcript
// 当前行高亮（startMs ≤ t < endMs）+ 自动滚动。transcript 时间轴是后处理管线回填的
// 确定性时间（±150ms 校验过），高亮随播放自然推进。行文本以 artifact.transcript
// 为准（合成时快照），脚本后续改动不影响已合成产物。
// 查找用二分（#29 验证项 2，transcript.ts 纯函数）；timeupdate 本身 ~4Hz 天然节流。
//
// 手感层：边听边对稿是这一步的真实用法，所以当前行除了底色还给一条左侧品牌色条
// （余光就能跟上进度），并给每行补上起始时刻——找某一句不用从头听。
export function MasterPlayer({ artifact, lines }: { artifact: Artifact; lines: ScriptLine[] }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playingSerial, setPlayingSerial] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)

  // 脚本行（写稿视图改动后）与 transcript 快照按 serial 对齐：拿到 latest 文本做淡
  // 化提示；transcript 是产物内嵌文本，正常两者一致。
  const lineBySerial = new Map(lines.map((l) => [l.serial, l]))

  const onTimeUpdate = () => {
    const audio = audioRef.current
    if (!audio) return
    const entry = transcriptEntryAt(artifact.transcript, audio.currentTime * 1000)
    setPlayingSerial(entry?.serial ?? null)
  }

  // 当前行自动滚动进可视区（seek 与自然播放都生效）
  const activeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [playingSerial])

  const seek = (startMs: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = startMs / 1000
    void audio.play()
  }

  return (
    <div className="animate-rise space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <AudioLines className="size-4 text-brand" />
          产物
        </h3>
        <Badge variant="secondary" className="text-xs tabular-nums">
          {formatClock(artifact.durationMs)}
        </Badge>
        <span className="text-xs text-muted-foreground tabular-nums">
          {artifact.transcript.length} 段 · {formatBytes(artifact.size)}
        </span>
        <a
          className="ml-auto flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          href={artifact.notesUrl}
          target="_blank"
          rel="noreferrer"
        >
          <FileText className="size-3" />
          show notes
        </a>
      </div>

      {/* 长音频保留原生控件：seek / 倍速 / 音量这些用户已经形成肌肉记忆，自研控件不划算 */}
      <audio
        ref={audioRef}
        src={artifact.audioUrl}
        controls
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={onTimeUpdate}
        className="w-full"
      />

      {artifact.transcript.length > 0 && (
        <ol className="scrollbar-slim max-h-72 space-y-0.5 overflow-y-auto">
          {artifact.transcript.map((entry) => {
            const active = entry.serial === playingSerial
            const drifted = lineBySerial.get(entry.serial)?.text !== entry.text
            return (
              <li key={entry.serial}>
                <button
                  type="button"
                  ref={active ? activeRef : undefined}
                  onClick={() => seek(entry.startMs)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md py-1.5 pr-2 pl-2 text-left transition-colors',
                    active ? 'bg-brand-soft' : 'hover:bg-muted/60',
                  )}
                >
                  {/* 当前行色条：播放中靠余光定位，不必逐行读字 */}
                  <span
                    aria-hidden
                    className={cn(
                      'mt-0.5 w-0.5 shrink-0 self-stretch rounded-full transition-colors',
                      active ? 'bg-brand' : 'bg-transparent',
                    )}
                  />
                  <span
                    className={cn(
                      'mt-0.5 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground',
                      active && 'font-semibold text-brand',
                    )}
                  >
                    {formatClock(entry.startMs)}
                  </span>
                  <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground/70">
                    {entry.serial}
                  </span>
                  <span className={cn('shrink-0 text-xs', active ? 'text-foreground' : 'text-muted-foreground')}>
                    {entry.speakerName}
                  </span>
                  <span className={cn('min-w-0 text-sm', !active && 'text-muted-foreground')}>
                    {entry.text}
                    {drifted && (
                      <span
                        className="ml-1 text-xs text-amber-600"
                        title="脚本该行在合成后改过，产物里还是旧文本"
                      >
                        （已改稿）
                      </span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      )}

      {!playing && playingSerial !== null && (
        <p className="text-[11px] text-muted-foreground">点任意一行可跳到该句</p>
      )}
    </div>
  )
}
