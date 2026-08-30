import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { Mic2, PenLine, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useEnsureCommitted } from '@/hooks/useEnsureCommitted'
import { useInvalidatedLineIds } from '@/hooks/useInvalidated'
import { episodeApi } from '@/lib/api/episode'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { Script, ScriptLine, Speaker } from '@/lib/api/types'
import { useStaging, type EditPatch } from '@/stores/staging'
import { isStaged } from './staging'
import { ScriptLineRow } from './ScriptLineRow'

// 写稿视图行列表（#30）：文本投影 + 行内联试听编排。
// 试听 = ensureCommitted（暂存非空先 POST /changes，合成只认已提交的稿）→
// preview（未合成则 TTS，命中素材直接返回）→ 直写 script 缓存（asset 翻转）+
// 清该行 invalidated 标记 → 该行展开播放器自动播放（试听别行即收起）。
// TTS 失败在行上显示错误（#19 验证项 3），完整超时/重试语义 M6。
export function ScriptLineList({
  episodeId,
  lines,
  speakers,
}: {
  episodeId: string
  lines: ScriptLine[]
  speakers: Speaker[]
}) {
  const { wsId = '' } = useParams()
  const ops = useStaging((s) => s.buffers[episodeId]?.ops)
  const stageAdd = useStaging((s) => s.stageAdd)
  const stageDelete = useStaging((s) => s.stageDelete)
  const stageEdit = useStaging((s) => s.stageEdit)
  const stageReorder = useStaging((s) => s.stageReorder)
  const queryClient = useQueryClient()
  const ensureCommitted = useEnsureCommitted(episodeId)
  const invalidated = useInvalidatedLineIds(episodeId)

  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const [error, setError] = useState<{ lineId: string; message: string } | null>(null)
  // 当前试听行：只在这一行展开播放器；token 驱动 force 同 URL 覆盖后的重取重播
  const [active, setActive] = useState<{ lineId: string; url: string; token: number } | null>(null)

  // 暂存新增行还没有库里的 line.id，preview 会 404
  const tempNewIds = useMemo(
    () => new Set((ops ?? []).filter((op) => op.op === 'add').map((op) => op.tempId)),
    [ops],
  )

  const addAfter = (afterLineId: string | null) => {
    stageAdd(episodeId, afterLineId, {
      speakerId: speakers[0]?.id ?? '',
      text: '',
      instructions: '',
    })
  }

  // 移动 = 对当前投影整序发一个 reorder op（后提交总是覆盖前一个）
  const move = (index: number, delta: -1 | 1) => {
    const ids = lines.map((l) => l.id)
    const target = index + delta
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    stageReorder(episodeId, ids)
  }

  const preview = async (line: ScriptLine, force: boolean) => {
    if (tempNewIds.has(line.id)) {
      toast.error('这行还没提交入库，先提交改动再试听')
      return
    }
    setPreviewingId(line.id)
    setError(null)
    try {
      if (!(await ensureCommitted())) return
      const res = await episodeApi.preview(episodeId, line.id, force)
      setActive((prev) => ({
        lineId: line.id,
        url: res.asset.url,
        token: prev?.lineId === line.id ? prev.token + 1 : 1,
      }))
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
      setError({ lineId: line.id, message: apiErrorMessage(e) })
    } finally {
      setPreviewingId(null)
    }
  }

  // 没有说话人时脚本行根本没法配音——这是阻塞项，给一条能直接去解决的引导
  if (speakers.length === 0) {
    return (
      <div className="mx-auto max-w-3xl p-4">
        <EmptyState
          icon={Mic2}
          title="这个工作间还没有说话人"
          description="说话人决定每行台词由谁说、用什么音色。先建一个，脚本行才能试听和合成。"
          action={
            <Button asChild size="sm">
              <Link to={`/workspaces/${wsId}/settings`}>去建说话人</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-2 p-4">
      {lines.length === 0 ? (
        <EmptyState
          icon={PenLine}
          title="还没有脚本行"
          description="自己写可以直接「加一行」；也可以让右边的写稿大师先起个草稿，你再逐句改。"
          action={
            <Button size="sm" onClick={() => addAfter(null)}>
              <Plus /> 加一行
            </Button>
          }
        />
      ) : (
        <>
          <div className="space-y-2">
            {lines.map((line, i) => (
              <ScriptLineRow
                key={line.id}
                line={line}
                speakers={speakers}
                staged={isStaged(ops ?? [], line.id)}
                isFirst={i === 0}
                isLast={i === lines.length - 1}
                canPreview={!tempNewIds.has(line.id)}
                needsResynth={!line.asset.has || invalidated.has(line.id)}
                previewing={previewingId === line.id}
                error={error?.lineId === line.id ? error.message : null}
                audioUrl={active?.lineId === line.id ? active.url : null}
                playToken={active?.lineId === line.id ? active.token : 0}
                onEdit={(patch: EditPatch) => stageEdit(episodeId, line.id, patch)}
                onPreview={(force) => void preview(line, force)}
                onDelete={() => stageDelete(episodeId, line.id)}
                onMoveUp={() => move(i, -1)}
                onMoveDown={() => move(i, 1)}
                onInsertAfter={() => addAfter(line.id)}
              />
            ))}
          </div>

          {/* 末尾整宽的加行条：比一个孤立的小按钮更好点，也标出了列表的结束位置 */}
          <button
            type="button"
            onClick={() => addAfter(lines[lines.length - 1]?.id ?? null)}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-2 text-xs text-muted-foreground transition-colors hover:border-brand-border hover:bg-brand-soft hover:text-foreground"
          >
            <Plus className="size-3.5" /> 加一行
          </button>
        </>
      )}
    </div>
  )
}
