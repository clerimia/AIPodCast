// 写稿大师三工具（CONTEXT.md「read/add/edit」+ ADR-0005）：TypeBox 参数，只调
// script service 的文本层函数——依赖方向单向 writer → script，工具够不到音频/
// 后期/产物。工具抛错由 SDK 捕获（error.message 回给模型，tool_execution_end
// isError:true），故直接 throw AppError。工具改动直写生效：applyChanges 走
// kind:'agent'（ADR-0002 工具发起的修改不追加 ChangeSet 通知、不走确认门）。
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Db } from '../../db/client.js'
import { AppError } from '../../shared/errors.js'
import { isUuid } from '../../shared/validate.js'
import type { ScriptOp } from '../script/apply-ops.js'
import * as scriptService from '../script/service.js'
import { briefText } from './text.js'

/** customTools 边界类型：SDK 侧 details 是 unknown（renderResult 逆变），具体类型只在工具内部推断 */
export type WriterTool = ToolDefinition<any, any, any>

/** details：SSE tool:end 的状态条摘要 + script:changed 的行级刷新依据 */
export interface WriterToolDetails {
  summary: string
  lineIds: string[]
}

/**
 * uuid 形状校验：模型偶尔会把说话人名当 id 传。直接进 DB 会炸出原生 SQL 错误，
 * 校验后以可读错误回给模型（SDK 捕获 → tool result error）。
 */
function requireUuidField(value: string, field: string): string {
  if (!isUuid(value)) {
    throw new AppError('BAD_REQUEST', `${field} 必须是 uuid（read 结果与第六层说话人里都有），收到：${value}`, 400)
  }
  return value
}

function formatLines(lines: scriptService.ScriptLineView[]): string {
  if (lines.length === 0) return '（脚本当前为空）'
  return lines
    .map((l) => {
      const inst = l.instructions ? `（指令：${l.instructions}）` : ''
      return `${l.serial} [id=${l.id}] ${l.speakerName}：${l.text}${inst}`
    })
    .join('\n')
}


export function makeWriterTools(db: Db, episodeId: string): WriterTool[] {
  const readTool = defineTool({
    name: 'read',
    label: '读脚本',
    description: '读取当前脚本：每行的行号、id、说话人、台词与指令。动笔前先 read。',
    parameters: Type.Object({}),
    execute: async () => {
      const script = await scriptService.getScript(db, episodeId)
      if (!script) throw new AppError('NOT_FOUND', 'episode not found', 404)
      return {
        content: [{ type: 'text', text: formatLines(script.lines) }],
        details: { summary: `读取脚本（${script.lines.length} 行）`, lineIds: [] },
      }
    },
  })

  const addTool = defineTool({
    name: 'add',
    label: '新增行',
    description: '在脚本中新增一行（说话人 + 台词 + 指令），插到某行之后或追加到末尾。',
    parameters: Type.Object({
      afterLineId: Type.Union([Type.String(), Type.Null()], {
        description: '插到该行之后；null = 追加到脚本末尾',
      }),
      speakerId: Type.String({ description: '说话人 id（read 结果里每行都有）' }),
      text: Type.String({ description: '台词' }),
      instructions: Type.Optional(Type.String({ description: '指令：这一行「怎么说」的自然语言描述' })),
    }),
    execute: async (_toolCallId, params) => {
      const afterLineId = params.afterLineId === null ? null : requireUuidField(params.afterLineId, 'afterLineId')
      const speakerId = requireUuidField(params.speakerId, 'speakerId')
      const applied = await scriptService.applyChanges(
        db,
        episodeId,
        [
          {
            op: 'add' as const,
            afterLineId,
            speakerId,
            text: params.text,
            instructions: params.instructions ?? '',
          },
        ],
        '写稿大师新增行',
        { kind: 'agent' },
      )
      if (!applied) throw new AppError('NOT_FOUND', 'episode not found', 404)
      const [addedId] = applied.addedLineIds
      const added = applied.lines.find((l) => l.id === addedId)
      return {
        content: [
          { type: 'text', text: `已新增 ${added?.serial ?? '行'}（id=${addedId ?? '?'}）：${briefText(params.text)}` },
        ],
        // lineIds = 前端脚本面板的刷新依据：add 带新增行（新行无素材，invalidated 为空）
        details: { summary: `新增 ${added?.serial ?? '行'}`, lineIds: applied.addedLineIds },
      }
    },
  })

  const editTool = defineTool({
    name: 'edit',
    label: '改行',
    description:
      '修改一行：改台词/指令/说话人、删除该行（delete:true）或移动位置（moveAfterLineId）。至少提供一项改动。',
    parameters: Type.Object({
      lineId: Type.String({ description: '目标行 id（read 结果里每行都有）' }),
      text: Type.Optional(Type.String({ description: '新的台词' })),
      instructions: Type.Optional(Type.String({ description: '新的指令' })),
      speakerId: Type.Optional(Type.String({ description: '换成该说话人' })),
      delete: Type.Optional(Type.Boolean({ description: 'true = 删除该行' })),
      moveAfterLineId: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: '移动该行到目标行之后；null = 移到最前。与 delete 互斥',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      if (params.delete === true && params.moveAfterLineId !== undefined) {
        throw new AppError('BAD_REQUEST', 'delete 与 moveAfterLineId 不能同时给出', 400)
      }
      const lineId = requireUuidField(params.lineId, 'lineId')
      const speakerId = params.speakerId === undefined ? undefined : requireUuidField(params.speakerId, 'speakerId')
      const moveAfterLineId =
        params.moveAfterLineId === undefined || params.moveAfterLineId === null
          ? params.moveAfterLineId
          : requireUuidField(params.moveAfterLineId, 'moveAfterLineId')
      const hasPatch =
        params.text !== undefined || params.instructions !== undefined || speakerId !== undefined
      const ops: ScriptOp[] = []

      if (params.delete === true) {
        ops.push({ op: 'delete', lineId })
      } else if (hasPatch) {
        ops.push({
          op: 'edit',
          lineId,
          patch: {
            ...(speakerId !== undefined && { speakerId }),
            ...(params.text !== undefined && { text: params.text }),
            ...(params.instructions !== undefined && { instructions: params.instructions }),
          },
        })
      }

      if (moveAfterLineId !== undefined) {
        if (moveAfterLineId === lineId) {
          throw new AppError('BAD_REQUEST', 'moveAfterLineId 不能是行自身', 400)
        }
        // reorder 是全序 op：按当前顺序构造 lineIds，把该行移到目标之后
        const script = await scriptService.getScript(db, episodeId)
        if (!script) throw new AppError('NOT_FOUND', 'episode not found', 404)
        const ids = script.lines.map((l) => l.id)
        if (moveAfterLineId !== null && !ids.includes(moveAfterLineId)) {
          throw new AppError('NOT_FOUND', 'moveAfterLineId not found', 404)
        }
        const from = ids.indexOf(lineId)
        if (from === -1) throw new AppError('NOT_FOUND', 'line not found', 404)
        ids.splice(from, 1)
        const at = moveAfterLineId === null ? 0 : ids.indexOf(moveAfterLineId) + 1
        ids.splice(at, 0, lineId)
        ops.push({ op: 'reorder', lineIds: ids })
      }

      if (ops.length === 0) {
        throw new AppError(
          'BAD_REQUEST',
          'edit 需要至少一项改动（text/instructions/speakerId/delete/moveAfterLineId）',
          400,
        )
      }

      const applied = await scriptService.applyChanges(
        db,
        episodeId,
        ops,
        params.delete === true ? '写稿大师删除行' : hasPatch ? '写稿大师修改行' : '写稿大师移动行',
        { kind: 'agent' },
      )
      if (!applied) throw new AppError('NOT_FOUND', 'episode not found', 404)

      const target = applied.lines.find((l) => l.id === lineId)
      const action =
        params.delete === true
          ? `已删除（id=${lineId}）`
          : `${hasPatch ? '已修改' : '已移动'} ${target?.serial ?? ''}（id=${lineId}）${
              hasPatch && params.text !== undefined ? `：${briefText(params.text, 60)}` : ''
            }`
      return {
        content: [{ type: 'text', text: action }],
        details: {
          summary: `${params.delete === true ? '删除' : hasPatch ? '修改' : '移动'} ${target?.serial ?? '行'}`,
          lineIds: applied.invalidatedLineIds,
        },
      }
    },
  })

  return [readTool, addTool, editTool]
}
