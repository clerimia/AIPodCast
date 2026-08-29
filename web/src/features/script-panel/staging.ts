// 脚本面板纯函数（frontend-structure.md「暂存/确认门」节）：ops → 文本侧行列表的投影。
// applyOps 与后端 server/src/modules/script/apply-ops.ts 语义一致（add/edit/delete/reorder
// 顺序应用 + serial 重编），但投影必须永不崩 UI：引用投影里不存在的行一律跳过（宽松语义）；
// 严格校验与报错由后端在提交时把守。shared 包本期不抽，两份实现对照测试保持一致。
import type { ChangeOp, ScriptLine } from '@/lib/api/types'

/** 暂存 op 内部形态：add 携带客户端临时 id（提交前剥离，见 toRequestOps） */
export type StagedAddOp = Extract<ChangeOp, { op: 'add' }> & { tempId: string }
export type StagedOp = StagedAddOp | Exclude<ChangeOp, { op: 'add' }>

/**
 * 规范形态 = POST /changes 的 ops 数组本身：add 的客户端 tempId 作为可选 `id` 随 op 发出，
 * 同一提交里后续 op（afterLineId / reorder）才能引用暂存新增行；服务端按 id 落库。
 */
export function toRequestOps(ops: StagedOp[]): ChangeOp[] {
  return ops.map((op) => {
    if (op.op === 'add') {
      const { tempId, ...add } = op
      return { ...add, id: tempId }
    }
    return op
  })
}

/**
 * 文本侧行列表 = Query 缓存叠暂存 ops（overlay 投影）。
 * add 置 null 锚点插最前；投影行的 id 用 add 的 tempId，同一提交里对该行的后续
 * edit/delete（store 层已并回 add 草稿）因此天然一致。
 */
export function applyOps(
  base: ScriptLine[],
  ops: StagedOp[],
  speakers: { id: string; name: string }[],
): ScriptLine[] {
  let lines = base.map((line) => ({ ...line }))

  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        const idx =
          op.afterLineId === null ? -1 : lines.findIndex((line) => line.id === op.afterLineId)
        if (idx === -1 && op.afterLineId !== null) break
        lines.splice(idx + 1, 0, {
          id: op.tempId,
          serial: '',
          speakerId: op.speakerId,
          speakerName: speakerName(speakers, op.speakerId),
          text: op.text,
          instructions: op.instructions ?? '',
          post: {},
          asset: { has: false, durationMs: null },
        })
        break
      }
      case 'edit': {
        const line = lines.find((l) => l.id === op.lineId)
        if (!line) break
        const { speakerId, text, instructions } = op.patch
        if (speakerId !== undefined) {
          line.speakerId = speakerId
          line.speakerName = speakerName(speakers, speakerId)
        }
        if (text !== undefined) line.text = text
        if (instructions !== undefined) line.instructions = instructions
        break
      }
      case 'delete': {
        lines = lines.filter((line) => line.id !== op.lineId)
        break
      }
      case 'reorder': {
        if (!isPermutation(op.lineIds, lines)) break
        lines = op.lineIds.map((id) => lines.find((line) => line.id === id)!)
        break
      }
    }
  }

  // serial 按最终顺序重编（与后端同格式：L001…）
  lines.forEach((line, i) => {
    line.serial = `L${String(i + 1).padStart(3, '0')}`
  })
  return lines
}

/** 该行是否带暂存改动（reorder 不算：行内容没变，位置变化已由 serial 呈现） */
export function isStaged(ops: StagedOp[], lineId: string): boolean {
  return ops.some(
    (op) =>
      (op.op === 'edit' || op.op === 'delete') && op.lineId === lineId
  )
}

/** 提交前置检查；返回阻断原因（null = 可提交） */
export function commitBlocker(ops: StagedOp[]): string | null {
  if (ops.some((op) => op.op === 'add' && op.text.trim() === '')) {
    return '有新增行还没写台词'
  }
  return null
}

function speakerName(speakers: { id: string; name: string }[], speakerId: string): string {
  return speakers.find((s) => s.id === speakerId)?.name ?? '（未知说话人）'
}

function isPermutation(ids: string[], lines: ScriptLine[]): boolean {
  if (ids.length !== lines.length) return false
  const unique = new Set(ids)
  if (unique.size !== ids.length) return false
  return lines.every((line) => unique.has(line.id))
}
