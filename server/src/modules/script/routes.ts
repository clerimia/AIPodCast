// script 模块路由（#19「单集与脚本」+「后期参数」表）。
// 校验（形状/档位）在路由层，约束（存在性/引用冲突/事务）在服务层；错误统一走
// app.ts 的 setErrorHandler → { error: { code, message } }。
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../shared/errors.js'
import { isPauseLevel, isSpeedLevel, type PauseLevel, type SpeedLevel } from '../../shared/post-params.js'
import { asBody, isUuid, optionalString, requireUuidField, requireUuidParam } from '../../shared/validate.js'
import type { ScriptOp } from './apply-ops.js'
import * as service from './service.js'

interface EpisodeParams {
  episodeId: string
}

interface LineParams {
  episodeId: string
  lineId: string
}

// op 形状解析：非法形状/缺失字段/非 uuid 引用一律 400 BAD_REQUEST；
// 「引用的行不存在」是状态冲突，交服务层/applyOps 以 409 报告。
function parseOp(raw: unknown): ScriptOp {
  if (typeof raw !== 'object' || raw === null) {
    throw new AppError('BAD_REQUEST', 'each op must be a JSON object', 400)
  }
  const op = raw as Record<string, unknown>
  switch (op.op) {
    case 'add': {
      const afterLineId = op.afterLineId
      if (afterLineId !== null && (typeof afterLineId !== 'string' || !isUuid(afterLineId))) {
        throw new AppError('BAD_REQUEST', "field 'afterLineId' must be a uuid or null", 400)
      }
      // 可选客户端预生成 id（uuid）：供同提交内后续 op 引用暂存新增行
      const id =
        op.id === undefined ? undefined : requireUuidField(op.id, 'id')
      const text = op.text
      if (typeof text !== 'string' || text.trim() === '') {
        throw new AppError('BAD_REQUEST', "field 'text' must be a non-empty string", 400)
      }
      const instructions = op.instructions
      if (instructions !== undefined && typeof instructions !== 'string') {
        throw new AppError('BAD_REQUEST', "field 'instructions' must be a string", 400)
      }
      return {
        op: 'add',
        id,
        afterLineId: afterLineId as string | null,
        speakerId: requireUuidField(op.speakerId, 'speakerId'),
        text: text.trim(),
        instructions: instructions ?? '',
      }
    }
    case 'edit': {
      if (typeof op.patch !== 'object' || op.patch === null) {
        throw new AppError('BAD_REQUEST', "field 'patch' must be a JSON object", 400)
      }
      const rawPatch = op.patch as Record<string, unknown>
      const patch: { speakerId?: string; text?: string; instructions?: string } = {}
      if (rawPatch.speakerId !== undefined) patch.speakerId = requireUuidField(rawPatch.speakerId, 'patch.speakerId')
      if (rawPatch.text !== undefined) {
        if (typeof rawPatch.text !== 'string' || rawPatch.text.trim() === '') {
          throw new AppError('BAD_REQUEST', "field 'patch.text' must be a non-empty string", 400)
        }
        patch.text = rawPatch.text.trim()
      }
      if (rawPatch.instructions !== undefined) {
        if (typeof rawPatch.instructions !== 'string') {
          throw new AppError('BAD_REQUEST', "field 'patch.instructions' must be a string", 400)
        }
        patch.instructions = rawPatch.instructions
      }
      return { op: 'edit', lineId: requireUuidField(op.lineId, 'lineId'), patch }
    }
    case 'delete':
      return { op: 'delete', lineId: requireUuidField(op.lineId, 'lineId') }
    case 'reorder': {
      const lineIds = op.lineIds
      if (
        !Array.isArray(lineIds) ||
        lineIds.length === 0 ||
        lineIds.some((id) => typeof id !== 'string' || !isUuid(id))
      ) {
        throw new AppError('BAD_REQUEST', "field 'lineIds' must be a non-empty array of uuids", 400)
      }
      return { op: 'reorder', lineIds: lineIds as string[] }
    }
    default:
      throw new AppError('BAD_REQUEST', `unknown op: ${String(op.op)}`, 400)
  }
}

function requirePostPatch(
  body: Record<string, unknown>,
  { allowNull }: { allowNull: boolean },
): { pause?: PauseLevel | null; speed?: SpeedLevel | null } {
  const patch: { pause?: PauseLevel | null; speed?: SpeedLevel | null } = {}
  for (const key of ['pause', 'speed'] as const) {
    if (!(key in body)) continue
    const value = body[key]
    const valid =
      value === null
        ? allowNull
        : key === 'pause'
          ? isPauseLevel(value)
          : isSpeedLevel(value)
    if (!valid) {
      const expected = allowNull ? 'a level or null' : 'a level'
      throw new AppError('BAD_REQUEST', `field '${key}' must be ${expected}`, 400)
    }
    if (key === 'pause') patch.pause = value as PauseLevel | null
    else patch.speed = value as SpeedLevel | null
  }
  if (Object.keys(patch).length === 0) {
    throw new AppError('BAD_REQUEST', "body must contain 'pause' or 'speed'", 400)
  }
  return patch
}

export async function scriptRoutes(app: FastifyInstance) {
  // 单集详情：title / show_notes / post_rules（产物摘要 M5 起有值，恒 null）
  app.get<{ Params: EpisodeParams }>('/:episodeId', async (req) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    const detail = await service.getEpisode(app.db, episodeId)
    if (!detail) throw new AppError('NOT_FOUND', 'episode not found', 404)
    return detail
  })

  // 读当前脚本：过滤 deleted、按 serial
  app.get<{ Params: EpisodeParams }>('/:episodeId/script', async (req) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    const script = await service.getScript(app.db, episodeId)
    if (!script) throw new AppError('NOT_FOUND', 'episode not found', 404)
    return script
  })

  // 改单集 title / show_notes（单集简介，ADR-0009 活字段；#19 表 2）
  app.patch<{ Params: EpisodeParams }>('/:episodeId', async (req) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    const body = asBody(req.body)
    const patch: { title?: string; showNotes?: string } = {}
    const title = optionalString(body, 'title')
    if (title !== undefined) patch.title = title
    const showNotes = optionalString(body, 'showNotes')
    if (showNotes !== undefined) patch.showNotes = showNotes
    const updated = await service.updateEpisode(app.db, episodeId, patch)
    if (!updated) throw new AppError('NOT_FOUND', 'episode not found', 404)
    return updated
  })

  // 暂存/确认门（ADR-0003）：把暂存改动一次性提交，单事务 + ChangeSet + 作废素材。
  // 路由层编排（modules-and-phasing 决策 2）：事务成功后再通知会话；script 不 import writer。
  app.post<{ Params: EpisodeParams }>('/:episodeId/changes', async (req) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    const body = asBody(req.body)
    if (!Array.isArray(body.ops) || body.ops.length === 0) {
      throw new AppError('BAD_REQUEST', "field 'ops' must be a non-empty array", 400)
    }
    const ops = body.ops.map(parseOp)
    const summary = optionalString(body, 'summary')?.trim() || null

    const applied = await service.applyChanges(app.db, episodeId, ops, summary)
    if (!applied) throw new AppError('NOT_FOUND', 'episode not found', 404)

    await app.writer.notifyChangeSet(episodeId, { id: applied.changeSetId, summary: applied.summary })
    return applied
  })

  // 集级后期默认（停顿/语速档位）：直接写，不经确认门、不追加 ChangeSet（ADR-0004）
  app.patch<{ Params: EpisodeParams }>('/:episodeId/post-rules', async (req) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    // allowNull:false 档位校验已排除 null，安全收窄为集级 patch
    const patch = requirePostPatch(asBody(req.body), { allowNull: false }) as Parameters<typeof service.updatePostRules>[2]
    const rules = await service.updatePostRules(app.db, episodeId, patch)
    if (!rules) throw new AppError('NOT_FOUND', 'episode not found', 404)
    return rules
  })

  // 逐行后期覆盖：字段给 null 清除该行覆盖；同样不经门
  app.patch<{ Params: LineParams }>('/:episodeId/lines/:lineId/post', async (req) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    const lineId = requireUuidParam(req.params.lineId, 'line')
    const patch = requirePostPatch(asBody(req.body), { allowNull: true })
    const post = await service.updateLinePost(app.db, episodeId, lineId, patch)
    if (!post) throw new AppError('NOT_FOUND', 'line not found', 404)
    return post
  })
}
