// 写稿大师三工具（CONTEXT.md「read/add/edit」+ ADR-0005）：TypeBox 参数，只调
// script service 的文本层函数——依赖方向单向 writer → script，工具够不到音频/
// 后期/产物。工具抛错由 SDK 捕获（error.message 回给模型，tool_execution_end
// isError:true），故直接 throw AppError。工具改动直写生效：applyChanges 走
// kind:'agent'（ADR-0002 工具发起的修改不追加 ChangeSet 通知、不走确认门）。
//
// add 锚点语义（#35 复盘 1）：afterLineId 缺省 = 追加到末尾（顺序写稿不传锚点，
// 靠 buildAddOps 链式预生成 id 保证同批多行按序）；null = 插到最前；uuid = 插到
// 该行之后。注意 applyOps 层 null = 最前（API 语义），「追加末尾」在工具层翻译成
// 末行 id，两者不可混用。
import { Type } from 'typebox'
import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Db } from '../../db/client.js'
import { episodes, speakers } from '../../db/schema.js'
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

/** 工作间说话人清单（id+name），冷启动引导用：空脚本 read 附加 + add 说话人报错提示（#35 复盘 2） */
async function wsSpeakerListText(db: Db, episodeId: string): Promise<string> {
  const [ep] = await db.select({ wsId: episodes.wsId }).from(episodes).where(eq(episodes.id, episodeId))
  if (!ep) return ''
  const rows = await db
    .select({ id: speakers.id, name: speakers.name })
    .from(speakers)
    .where(eq(speakers.wsId, ep.wsId))
    .orderBy(asc(speakers.createdAt))
  if (rows.length === 0) return '（该工作间还没有说话人）'
  return rows.map((s) => `- ${s.name}（speakerId=${s.id}）`).join('\n')
}

// ---- add op 构造（纯函数，可单测） ----

export interface AddItemInput {
  speakerId: string
  text: string
  instructions: string
}

/**
 * 把 N 个新增行编译成链式 add op（#35 复盘 1）：
 * 首行锚定 afterLineId（undefined = 追加末尾 → 末行 id，空脚本 → null 即最前），
 * 后续行依次锚定前一行的预生成 id（applyOps 支持同提交内引用 add.id）。
 * 这样顺序写稿不需要模型反复给锚点，一次调用即可按序落 N 行。
 */
export function buildAddOps(
  items: AddItemInput[],
  afterLineId: string | null | undefined,
  lastLineId: string | null,
  newId: () => string,
): ScriptOp[] {
  const ids = items.map(() => newId())
  // 缺省锚点在编译期就归约为 string|null（追加末尾 → 末行 id；空脚本 → null 即最前）
  const anchor: string | null = afterLineId === undefined ? lastLineId : afterLineId
  return items.map((item, i): ScriptOp => ({
    op: 'add',
    id: ids[i]!,
    afterLineId: i === 0 ? anchor : ids[i - 1]!,
    speakerId: item.speakerId,
    text: item.text,
    instructions: item.instructions,
  }))
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
      let text = formatLines(script.lines)
      // 空脚本（冷启动）：read 结果自带说话人清单，模型不用盲猜 speakerId（#35 复盘 2）
      if (script.lines.length === 0) {
        text += `\n\n可用说话人（speakerId 用这里的 uuid）：\n${await wsSpeakerListText(db, episodeId)}`
      }
      return {
        content: [{ type: 'text', text }],
        details: { summary: `读取脚本（${script.lines.length} 行）`, lineIds: [] },
      }
    },
  })

  const addTool = defineTool({
    name: 'add',
    label: '新增行',
    description:
      '在脚本中新增一行或多行（按给定顺序落稿）。顺序写稿不要传 afterLineId：多行用 lines 数组一次给全，新行依次追加到脚本末尾。只有插到脚本中间时才传 afterLineId。',
    parameters: Type.Object({
      afterLineId: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description:
            '插入锚点：缺省 = 追加到脚本末尾（顺序写稿不要传）；null = 插到最前；行 id = 插到该行之后',
        }),
      ),
      speakerId: Type.Optional(Type.String({ description: '说话人 id（单行写法；read 结果或第六层说话人里有）' })),
      text: Type.Optional(Type.String({ description: '台词（单行写法）' })),
      instructions: Type.Optional(
        Type.String({ description: '指令：这一行「怎么说」的自然语言描述（单行写法）' }),
      ),
      lines: Type.Optional(
        Type.Array(
          Type.Object({
            speakerId: Type.String({ description: '说话人 id' }),
            text: Type.String({ description: '台词' }),
            instructions: Type.Optional(Type.String({ description: '指令' })),
          }),
          {
            description:
              '多行写法（推荐）：按写作顺序一次给出全部新增行，逐行追加；比逐行调用省轮次且不会乱序',
          },
        ),
      ),
    }),
    execute: async (_toolCallId, params) => {
      // 单行写法（speakerId/text）与多行写法（lines）二选一
      if (params.lines && (params.speakerId !== undefined || params.text !== undefined)) {
        throw new AppError('BAD_REQUEST', 'lines 与 speakerId/text 二选一，不要混用', 400)
      }
      const rawItems: { speakerId: string; text: string; instructions?: string }[] = []
      if (params.lines) {
        rawItems.push(...params.lines)
      } else {
        if (params.speakerId === undefined || params.text === undefined) {
          throw new AppError('BAD_REQUEST', '需要 lines 数组（多行）或 speakerId + text（单行）', 400)
        }
        rawItems.push({ speakerId: params.speakerId, text: params.text, instructions: params.instructions })
      }
      const items: AddItemInput[] = rawItems.map((item) => ({
        speakerId: requireUuidField(item.speakerId, 'speakerId'),
        text: item.text,
        instructions: item.instructions ?? '',
      }))

      const afterLineId =
        params.afterLineId === undefined || params.afterLineId === null
          ? params.afterLineId
          : requireUuidField(params.afterLineId, 'afterLineId')

      // 缺省锚点 = 追加末尾：翻译成当前末行 id（空脚本 → null 即最前）
      let lastLineId: string | null = null
      if (afterLineId === undefined) {
        const script = await scriptService.getScript(db, episodeId)
        if (!script) throw new AppError('NOT_FOUND', 'episode not found', 404)
        lastLineId = script.lines.at(-1)?.id ?? null
      }

      let applied: scriptService.ApplyChangesResult | null
      try {
        applied = await scriptService.applyChanges(
          db,
          episodeId,
          buildAddOps(items, afterLineId, lastLineId, () => randomUUID()),
          items.length > 1 ? `写稿大师新增 ${items.length} 行` : '写稿大师新增行',
          { kind: 'agent' },
        )
      } catch (err) {
        // 说话人引用失败：把可用说话人清单附进错误，模型一轮自纠而不是盲猜重试（#35 复盘 2）
        if (err instanceof AppError && (err.message === 'speaker not found' || err.message.startsWith('speakerId'))) {
          throw new AppError(err.code, `${err.message}\n可用说话人：\n${await wsSpeakerListText(db, episodeId)}`, err.statusCode)
        }
        throw err
      }
      if (!applied) throw new AppError('NOT_FOUND', 'episode not found', 404)

      const added = applied.addedLineIds
        .map((id) => applied.lines.find((l) => l.id === id))
        .filter((l) => l !== undefined)
      const summary =
        added.length > 1 ? `新增 ${added.length} 行（${added[0]?.serial}–${added.at(-1)?.serial}）` : `新增 ${added[0]?.serial ?? '行'}`
      const text = `已新增 ${added
        .map((l) => `${l.serial}（id=${l.id}）`)
        .join('、')}：${briefText(added.map((l) => l.text).join(' / '))}`
      return {
        content: [{ type: 'text', text }],
        // lineIds = 前端脚本面板的刷新依据：add 带新增行（新行无素材，invalidated 为空）
        details: { summary, lineIds: applied.addedLineIds },
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

      let applied: scriptService.ApplyChangesResult | null
      try {
        applied = await scriptService.applyChanges(
          db,
          episodeId,
          ops,
          params.delete === true ? '写稿大师删除行' : hasPatch ? '写稿大师修改行' : '写稿大师移动行',
          { kind: 'agent' },
        )
      } catch (err) {
        if (err instanceof AppError && (err.message === 'speaker not found' || err.message.startsWith('speakerId'))) {
          throw new AppError(err.code, `${err.message}\n可用说话人：\n${await wsSpeakerListText(db, episodeId)}`, err.statusCode)
        }
        throw err
      }
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
