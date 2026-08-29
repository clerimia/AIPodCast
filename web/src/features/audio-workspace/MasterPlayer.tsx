import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { Artifact, ScriptLine } from '@/lib/api/types'

// MasterPlayer（M5，#28）：后处理产物播放器。<audio> + timeupdate 驱动 transcript
// 当前行高亮（startMs ≤ t < endMs）+ 自动滚动。transcript 时间轴是后处理管线回填的
// 确定性时间（±150ms 校验过），高亮随播放自然推进。行文本以 artifact.transcript
// 为准（合成时快照），脚本后续改动不影响已合成产物。
export function MasterPlayer({ artifact, lines }: { artifact: Artifact; lines: ScriptLine[] }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playingSerial, setPlayingSerial] = useState<string | null>(null)

  // 脚本行（写稿视图改动后）与 transcript 快照按 serial 对齐：拿到 latest 文本做淡
  // 化提示；transcript 是产物内嵌文本，正常两者一致。
  const lineBySerial = new Map(lines.map((l) => [l.serial, l]))

  const onTimeUpdate = () => {
    const audio = audioRef.current
    if (!audio) return
    const ms = audio.currentTime * 1000
    const entry = artifact.transcript.find((t) => ms >= t.startMs && ms < t.endMs)
    setPlayingSerial(entry?.serial ?? null)
  }

  // 当前行自动滚动进可视区（seek 与自然播放都生效）
  const activeRef = useRef<HTMLLIElement>(null)
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
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">产物</h3>
        <Badge variant="secondary" className="text-xs">
          {(artifact.durationMs / 1000).toFixed(1)}s
        </Badge>
        <span className="text-xs text-muted-foreground">
          {artifact.transcript.length} 段 · {(artifact.size / 1024 / 1024).toFixed(1)}MB mp3
        </span>
        <a
          className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
          href={artifact.notesUrl}
          target="_blank"
          rel="noreferrer"
        >
          show notes
        </a>
      </div>

      <audio ref={audioRef} src={artifact.audioUrl} controls onTimeUpdate={onTimeUpdate} className="w-full" />

      {artifact.transcript.length > 0 && (
        <ol className="max-h-64 space-y-1 overflow-y-auto">
          {artifact.transcript.map((entry) => {
            const active = entry.serial === playingSerial
            const drifted = lineBySerial.get(entry.serial)?.text !== entry.text
            return (
              <li
                key={entry.serial}
                ref={active ? activeRef : undefined}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 transition-colors',
                  active ? 'bg-primary/10' : 'hover:bg-muted/60',
                )}
                onClick={() => seek(entry.startMs)}
              >
                <span
                  className={cn(
                    'mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground',
                    active && 'font-semibold text-primary',
                  )}
                >
                  {entry.serial}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{entry.speakerName}</span>
                <span className={cn('min-w-0 text-sm', !active && 'text-muted-foreground')}>
                  {entry.text}
                  {drifted && (
                    <span className="ml-1 text-xs text-amber-600" title="脚本该行在合成后改过，产物里还是旧文本">
                      （已改稿）
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
