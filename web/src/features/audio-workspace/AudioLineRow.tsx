import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Play, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PauseSpeedSelect } from '@/components/script/PauseSpeedSelect'
import { SerialBadge } from '@/components/script/SerialBadge'
import { episodeApi } from '@/lib/api/episode'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { LinePost, Script, ScriptLine } from '@/lib/api/types'
import { cn } from '@/lib/utils'

// 音频工作区行级（M4，frontend-structure.md 的 AudioLineRow）：试听 = 单行合成（同步）
// + 单行播放 + 「需重新合成」标记（asset.has 与 invalidatedLineIds，#19/#27）+
// 停顿/语速逐行覆盖下拉（ADR-0004：PATCH 直写落库、即时生效、不经门）。
// 试听成功即自动播放（load() 强制重取——force 重生成是同 URL 覆盖）；失败在行上显示
// 错误（#19 验证项 3），不白屏；完整超时/重试语义 M6。

export function AudioLineRow({
  episodeId,
  line,
  invalidated,
}: {
  episodeId: string
  line: ScriptLine
  invalidated: boolean
}) {
  const queryClient = useQueryClient()
  const audioRef = useRef<HTMLAudioElement>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 每次 preview 成功自增：同一 URL 被 force 重生成覆盖后也强制 audio 重取重播
  const [playToken, setPlayToken] = useState(0)

  const needsResynth = !line.asset.has || invalidated

  useEffect(() => {
    const el = audioRef.current
    if (playToken === 0 || !el) return
    el.load()
    // 用户点击「试听」后的程序化播放属合法手势；被策略拒绝时行上仍有 controls 可手动播
    void el.play().catch(() => {})
  }, [playToken, audioUrl])

  const preview = async (force: boolean) => {
    setPending(true)
    setError(null)
    try {
      const res = await episodeApi.preview(episodeId, line.id, force)
      setAudioUrl(res.asset.url)
      setPlayToken((n) => n + 1)
      // 素材已生成：直写脚本缓存（asset 翻转）并清该行的作废标记
      queryClient.setQueryData<Script>(qk.script(episodeId), (old) =>
        old
          ? {
              lines: old.lines.map((l) =>
                l.id === line.id ? { ...l, asset: { has: true, durationMs: res.asset.durationMs } } : l,
              ),
            }
          : old,
      )
      queryClient.setQueryData<string[]>(qk.invalidated(episodeId), (old) =>
        (old ?? []).filter((id) => id !== line.id),
      )
    } catch (e) {
      setError(apiErrorMessage(e))
    } finally {
      setPending(false)
    }
  }

  const patchPost = async (patch: LinePost) => {
    try {
      const post = await episodeApi.updateLinePost(episodeId, line.id, patch)
      queryClient.setQueryData<Script>(qk.script(episodeId), (old) =>
        old ? { lines: old.lines.map((l) => (l.id === line.id ? { ...l, post } : l)) } : old,
      )
    } catch (e) {
      toast.error(`停顿/语速保存失败：${apiErrorMessage(e)}`)
    }
  }

  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 transition-colors',
        invalidated && 'border-amber-500/50',
      )}
    >
      <div className="flex items-center gap-2">
        <SerialBadge serial={line.serial} />
        <span className="shrink-0 text-xs text-muted-foreground">{line.speakerName}</span>
        <span className="min-w-0 flex-1 truncate text-sm">
          {line.text || <span className="text-muted-foreground">（空行）</span>}
        </span>
        {needsResynth && (
          <Badge variant="outline" className="shrink-0 border-amber-500/50 text-xs text-amber-600">
            需重新合成
          </Badge>
        )}
        <div className="flex shrink-0 gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={`试听 ${line.serial}`}
            title="试听（命中素材直接播，未合成则先合成，秒级）"
            disabled={pending}
            onClick={() => void preview(false)}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Play />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`强制重新合成 ${line.serial}`}
            title="强制重新合成（force，重新调 TTS）"
            disabled={pending}
            onClick={() => void preview(true)}
          >
            <RotateCcw />
          </Button>
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <PauseSpeedSelect value={line.post} withFollowDefault onChange={(patch) => void patchPost(patch)} />
        {audioUrl ? (
          <audio ref={audioRef} controls preload="none" src={audioUrl} className="ml-auto h-8 w-2/3" />
        ) : (
          <span className="ml-auto text-xs text-muted-foreground">
            {needsResynth ? '点试听合成并播放' : '点试听播放'}
          </span>
        )}
      </div>

      {error && <p className="mt-1 text-xs text-destructive">试听失败：{error}</p>}
    </div>
  )
}
