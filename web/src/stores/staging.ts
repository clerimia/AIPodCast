// 暂存门缓冲（ADR-0003，frontend-structure.md）：客户端纯状态，按 episodeId 区分。
// 规范形态 = POST /changes 的 ops 数组本身（带客户端 tempId 的新增行提交前剥离）。
// 累积规则：
// - 同一行连续 edit → patch 并进最后一个 edit op（打字不膨胀 ops）；
// - 暂存新增行（tempId）上的编辑 → 并回 add 草稿本身；
// - 删暂存新增行 → 整体撤下 add；删已有行 → 顺带清掉该行先前暂存的 edit（≡ 只删）；
// - 连续 reorder → 用新全序覆盖（总是按当前投影整序发出，避免引用已删行）。
import { create } from 'zustand'
import type { StagedOp } from '@/features/script-panel/staging'

export interface EditPatch {
  speakerId?: string
  text?: string
  instructions?: string
}

interface StagingBuffer {
  ops: StagedOp[]
  summary: string
}

interface StagingState {
  buffers: Record<string, StagingBuffer>
  /** 改台词/指令/说话人 → 进暂存（不改库，ADR-0003） */
  stageEdit: (episodeId: string, lineId: string, patch: EditPatch) => void
  /** 新增一行，返回客户端临时 id（投影行用） */
  stageAdd: (
    episodeId: string,
    afterLineId: string | null,
    draft: { speakerId: string; text: string; instructions?: string },
  ) => string
  stageDelete: (episodeId: string, lineId: string) => void
  /** 全序重排（lineIds = 当前投影全部行 id 的新顺序） */
  stageReorder: (episodeId: string, lineIds: string[]) => void
  setSummary: (episodeId: string, summary: string) => void
  /** 撤销全部：界面回到服务器投影 */
  clearAll: (episodeId: string) => void
}

function bufferOf(state: Pick<StagingState, 'buffers'>, episodeId: string): StagingBuffer {
  return state.buffers[episodeId] ?? { ops: [], summary: '' }
}

function withBuffer(
  state: Pick<StagingState, 'buffers'>,
  episodeId: string,
  ops: StagedOp[],
  summary?: string,
): Pick<StagingState, 'buffers'> {
  const buf = bufferOf(state, episodeId)
  return {
    buffers: {
      ...state.buffers,
      [episodeId]: { ops, summary: summary ?? buf.summary },
    },
  }
}

export const useStaging = create<StagingState>((set) => ({
  buffers: {},

  stageEdit: (episodeId, lineId, patch) =>
    set((state) => {
      const buf = bufferOf(state, episodeId)
      const ops = [...buf.ops]

      // 编辑的是已暂存的新行：并回 add 草稿
      const addIdx = ops.findIndex((op) => op.op === 'add' && op.tempId === lineId)
      if (addIdx !== -1) {
        const add = ops[addIdx] as Extract<StagedOp, { op: 'add' }>
        ops[addIdx] = {
          ...add,
          speakerId: patch.speakerId ?? add.speakerId,
          text: patch.text ?? add.text,
          instructions: patch.instructions ?? add.instructions,
        }
        return withBuffer(state, episodeId, ops)
      }

      // 同一行连续编辑：并进最后一个 edit op
      const last = ops[ops.length - 1]
      if (last && last.op === 'edit' && last.lineId === lineId) {
        ops[ops.length - 1] = { ...last, patch: { ...last.patch, ...patch } }
      } else {
        ops.push({ op: 'edit', lineId, patch })
      }
      return withBuffer(state, episodeId, ops)
    }),

  stageAdd: (episodeId, afterLineId, draft) => {
    const tempId = crypto.randomUUID()
    set((state) => {
      const buf = bufferOf(state, episodeId)
      const ops: StagedOp[] = [
        ...buf.ops,
        {
          op: 'add',
          tempId,
          afterLineId,
          speakerId: draft.speakerId,
          text: draft.text,
          instructions: draft.instructions ?? '',
        },
      ]
      return withBuffer(state, episodeId, ops)
    })
    return tempId
  },

  stageDelete: (episodeId, lineId) =>
    set((state) => {
      const buf = bufferOf(state, episodeId)
      // 新增行还没进库：整体撤下
      if (buf.ops.some((op) => op.op === 'add' && op.tempId === lineId)) {
        const ops = buf.ops.filter((op) => !(op.op === 'add' && op.tempId === lineId))
        return withBuffer(state, episodeId, ops)
      }
      // 已有行：先前的暂存 edit 一并清掉（编辑后删除 ≡ 删除）
      const ops = buf.ops.filter((op) => !(op.op === 'edit' && op.lineId === lineId))
      ops.push({ op: 'delete', lineId })
      return withBuffer(state, episodeId, ops)
    }),

  stageReorder: (episodeId, lineIds) =>
    set((state) => {
      const buf = bufferOf(state, episodeId)
      const ops = [...buf.ops]
      const last = ops[ops.length - 1]
      if (last && last.op === 'reorder') {
        ops[ops.length - 1] = { op: 'reorder', lineIds }
      } else {
        ops.push({ op: 'reorder', lineIds })
      }
      return withBuffer(state, episodeId, ops)
    }),

  setSummary: (episodeId, summary) =>
    set((state) => withBuffer(state, episodeId, bufferOf(state, episodeId).ops, summary)),

  clearAll: (episodeId) =>
    set((state) => withBuffer(state, episodeId, [], '')),
}))
