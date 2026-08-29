// ops 应用纯函数（docs/modules-and-phasing.md「script 模块」）：
// add/edit/delete/reorder 按序应用到工作集 → 最终活行（serial 按序重编）。
// 只做顺序/引用层面的校验，不碰 DB；存在性（说话人等）由 service 先行校验。
// 严格语义：引用工作集里不存在的行（含已删/别集的行）一律抛 4xx，前端按错误 toast。
import { AppError } from '../../shared/errors.js'
import { formatSerial } from '../../shared/serial.js'

// ---- 线路形状（路由层已解析为合法形状的 op）----

export interface AddOp {
  op: 'add'
  /**
   * 可选客户端预生成行 id（uuid）：同一提交里的后续 op（afterLineId / edit / reorder）
   * 可引用暂存新增行。缺省由服务端生成；与现有行冲突 → 409（service 校验）。
   */
  id?: string
  /** 在该行之后插入；null = 插到最前 */
  afterLineId: string | null
  speakerId: string
  text: string
  instructions: string
}

export interface EditOp {
  op: 'edit'
  lineId: string
  patch: { speakerId?: string; text?: string; instructions?: string }
}

export interface DeleteOp {
  op: 'delete'
  lineId: string
}

export interface ReorderOp {
  op: 'reorder'
  /** 全序：必须是当前活行 id 的一个排列 */
  lineIds: string[]
}

export type ScriptOp = AddOp | EditOp | DeleteOp | ReorderOp

/** add 预生成了行 id 的 op（同一次提交里后续 op 可引用新行） */
export type ResolvedOp = (AddOp & { id: string }) | EditOp | DeleteOp | ReorderOp

export function resolveOps(ops: ScriptOp[], newId: () => string): ResolvedOp[] {
  return ops.map((op) => (op.op === 'add' ? { ...op, id: op.id ?? newId() } : op))
}

// ---- 工作集行：文本层最小投影，顺序 = 数组序 ----

export interface OpLine {
  id: string
  serial: string
  speakerId: string
  text: string
  instructions: string
}

export interface ApplyOpsResult {
  /** 最终活行（数组序 = 最终顺序，serial 已按序重编） */
  lines: OpLine[]
  /** 本次新增的行 */
  addedIds: string[]
  /** 文本层实际发生变化的存活行（作废素材依据；同值 patch 不算变化） */
  editedIds: string[]
  /** 本次被逻辑删除的行 */
  deletedIds: string[]
}

export function applyOps(base: OpLine[], ops: ResolvedOp[]): ApplyOpsResult {
  const lines = base.map((line) => ({ ...line }))
  const addedIds: string[] = []
  const deletedIds: string[] = []
  const editedIds: string[] = []

  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        // null 锚点 = 插到最前（idx = -1，splice(idx+1) 落在头上）
        const idx =
          op.afterLineId === null
            ? -1
            : lines.findIndex((line) => line.id === op.afterLineId)
        if (idx === -1 && op.afterLineId !== null) {
          throw new AppError('CONFLICT', `add.afterLineId does not match a line of this episode`, 409)
        }
        lines.splice(idx + 1, 0, {
          id: op.id,
          serial: '',
          speakerId: op.speakerId,
          text: op.text,
          instructions: op.instructions,
        })
        addedIds.push(op.id)
        break
      }
      case 'edit': {
        const line = lines.find((l) => l.id === op.lineId)
        if (!line) {
          throw new AppError('CONFLICT', `edit.lineId does not match a line of this episode`, 409)
        }
        const { patch } = op
        const changed =
          (patch.text !== undefined && patch.text !== line.text) ||
          (patch.instructions !== undefined && patch.instructions !== line.instructions) ||
          (patch.speakerId !== undefined && patch.speakerId !== line.speakerId)
        if (!changed) break
        if (patch.speakerId !== undefined) line.speakerId = patch.speakerId
        if (patch.text !== undefined) line.text = patch.text
        if (patch.instructions !== undefined) line.instructions = patch.instructions
        editedIds.push(line.id)
        break
      }
      case 'delete': {
        const idx = lines.findIndex((line) => line.id === op.lineId)
        if (idx === -1) {
          throw new AppError('CONFLICT', `delete.lineId does not match a line of this episode`, 409)
        }
        lines.splice(idx, 1)
        deletedIds.push(op.lineId)
        break
      }
      case 'reorder': {
        if (!isPermutationOf(op.lineIds, lines)) {
          throw new AppError(
            'BAD_REQUEST',
            'reorder.lineIds must be a permutation of the current line ids',
            400,
          )
        }
        const byId = new Map(lines.map((line) => [line.id, line]))
        lines.length = 0
        for (const id of op.lineIds) lines.push(byId.get(id)!)
        break
      }
    }
  }

  // serial 按最终顺序整段重编（删除行保留旧 serial，永不在投影出现）
  lines.forEach((line, i) => {
    line.serial = formatSerial(i + 1)
  })

  return { lines, addedIds, editedIds, deletedIds }
}

function isPermutationOf(ids: string[], lines: OpLine[]): boolean {
  if (ids.length !== lines.length) return false
  const unique = new Set(ids)
  if (unique.size !== ids.length) return false
  return lines.every((line) => unique.has(line.id))
}
