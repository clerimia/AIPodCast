import { useMemo } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ScriptLine, Speaker } from '@/lib/api/types'
import { useStaging, type EditPatch } from '@/stores/staging'
import { ScriptLineRow } from './ScriptLineRow'

// 脚本行面板（文本投影）：['script', ep] 缓存叠暂存 ops 的行列表（投影在 EpisodePage 算好）。
// 「加一行」追加到末尾（空脚本 = null 锚点插最前）；行内“在下方插入”见 Row。
export function ScriptLineList({
  episodeId,
  lines,
  speakers,
}: {
  episodeId: string
  lines: ScriptLine[]
  speakers: Speaker[]
}) {
  const ops = useStaging((s) => s.buffers[episodeId]?.ops)
  const stageAdd = useStaging((s) => s.stageAdd)
  const stageDelete = useStaging((s) => s.stageDelete)
  const stageEdit = useStaging((s) => s.stageEdit)
  const stageReorder = useStaging((s) => s.stageReorder)

  // 每行的暂存标记只随 ops 变化重算
  const stagedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const op of ops ?? []) {
      if (op.op === 'edit' || op.op === 'delete') ids.add(op.lineId)
      if (op.op === 'add') ids.add(op.tempId)
    }
    return ids
  }, [ops])

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

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4">
      {speakers.length === 0 && (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          这个工作间还没有说话人：先到「工作间设置」里建说话人，才能给脚本行配音。
        </p>
      )}

      {lines.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          还没有脚本行。点「加一行」手动写；M3 起写稿大师也会把稿写到这里。
        </p>
      ) : (
        <div className="space-y-2">
          {lines.map((line, i) => (
            <ScriptLineRow
              key={line.id}
              line={line}
              speakers={speakers}
              staged={stagedIds.has(line.id)}
              isFirst={i === 0}
              isLast={i === lines.length - 1}
              onEdit={(patch: EditPatch) => stageEdit(episodeId, line.id, patch)}
              onDelete={() => stageDelete(episodeId, line.id)}
              onMoveUp={() => move(i, -1)}
              onMoveDown={() => move(i, 1)}
              onInsertAfter={() => addAfter(line.id)}
            />
          ))}
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        disabled={speakers.length === 0}
        onClick={() => addAfter(lines[lines.length - 1]?.id ?? null)}
      >
        <Plus /> 加一行
      </Button>
    </div>
  )
}
