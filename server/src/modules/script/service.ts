// 脚本服务（#19「单集与脚本」+「后期参数」）：文本层真相源。
// 职责边界（docs/modules-and-phasing.md）：不碰 TTS/ffmpeg；不 import writer——
// ChangeSet→会话通知由路由层在事务成功后编排。
// 作废素材 = 事务内删 audio_assets 行（一个 DB 操作，不调 synthesis）。
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import {
  audioAssets,
  changeSetOps,
  changeSets,
  episodes,
  postRules,
  scriptLines,
  speakers,
} from '../../db/schema.js'
import { AppError } from '../../shared/errors.js'
import type { LinePost, PauseLevel, SpeedLevel } from '../../shared/post-params.js'
import { parseSerial } from '../../shared/serial.js'
import { applyOps, resolveOps, type OpLine, type ScriptOp } from './apply-ops.js'

/** db.transaction 回调里的事务句柄（与 Db 同一查询面，作用域限于事务内） */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

// GET script 每行（docs/api-and-dataflow.md 的 jsonc 形状）
export interface ScriptLineView {
  id: string
  serial: string
  speakerId: string
  speakerName: string
  text: string
  instructions: string
  post: LinePost
  asset: { has: boolean; durationMs: number | null }
}

export interface EpisodeDetail {
  id: string
  wsId: string
  title: string
  showNotes: string
  postRules: { pause: PauseLevel; speed: SpeedLevel }
  /** M5 起为最新产物摘要；M2 尚无合成，恒 null */
  artifact: null
}

export interface ApplyChangesResult {
  changeSetId: string
  /** 素材已作废的行（改台词/指令/说话人的存活行 + 被删行）；纯 reorder/空 patch 不产生 */
  invalidatedLineIds: string[]
  lines: ScriptLineView[]
  /** 透传给路由层的通知编排（writer.session.notifyChangeSet） */
  summary: string | null
}

// ---- 单集详情 ----

export async function getEpisode(db: Db, episodeId: string): Promise<EpisodeDetail | null> {
  const [ep] = await db
    .select({ id: episodes.id, wsId: episodes.wsId, title: episodes.title, showNotes: episodes.showNotes })
    .from(episodes)
    .where(eq(episodes.id, episodeId))
  if (!ep) return null
  const [rules] = await db
    .select({ pause: postRules.pause, speed: postRules.speed })
    .from(postRules)
    .where(eq(postRules.episodeId, episodeId))
  return {
    ...ep,
    // 建单集连带 post_rules 默认行；缺行只在历史脏数据下出现，回退默认档位
    postRules: { pause: (rules?.pause ?? '中') as PauseLevel, speed: (rules?.speed ?? '正常') as SpeedLevel },
    artifact: null,
  }
}

// ---- 脚本投影（GET script；applyChanges 响应复用）----

const lineColumns = {
  id: scriptLines.id,
  serial: scriptLines.serial,
  speakerId: scriptLines.speakerId,
  speakerName: speakers.name,
  text: scriptLines.text,
  instructions: scriptLines.instructions,
  post: scriptLines.post,
  assetId: audioAssets.id,
  assetDurationMs: audioAssets.durationMs,
}

export async function getScript(
  db: Db,
  episodeId: string,
): Promise<{ lines: ScriptLineView[] } | null> {
  if (!(await episodeExists(db, episodeId))) return null
  return { lines: await scriptLineViews(db, episodeId) }
}

async function episodeExists(db: Db, episodeId: string): Promise<boolean> {
  const [row] = await db.select({ id: episodes.id }).from(episodes).where(eq(episodes.id, episodeId))
  return row !== undefined
}

/** 活行投影：过滤 deleted、按 serial 数值序（L1000 > L999，字符串序会排错）、左联素材 */
async function scriptLineViews(db: Db, episodeId: string): Promise<ScriptLineView[]> {
  const rows = await db
    .select(lineColumns)
    .from(scriptLines)
    .innerJoin(speakers, eq(speakers.id, scriptLines.speakerId))
    .leftJoin(audioAssets, eq(audioAssets.scriptLineId, scriptLines.id))
    .where(and(eq(scriptLines.episodeId, episodeId), eq(scriptLines.deleted, false)))
  return rows
    .sort((a, b) => parseSerial(a.serial) - parseSerial(b.serial))
    .map((row) => ({
    id: row.id,
    serial: row.serial,
    speakerId: row.speakerId,
    speakerName: row.speakerName,
    text: row.text,
    instructions: row.instructions,
    post: (row.post ?? {}) as LinePost,
    asset: { has: row.assetId !== null, durationMs: row.assetDurationMs },
  }))
}

// ---- 暂存/确认门（ADR-0003）：一次提交 = 一个事务 = 一条 ChangeSet ----

/**
 * 单事务应用 ops：
 * 1. ops → script_lines（删除 = deleted=true；插入/重排按最终顺序重编 serial）；
 * 2. 写 change_sets + change_set_ops（base_version 取已有条数，仅作顺序计数）；
 * 3. 作废受影响行素材（改台词/指令/说话人的存活行 + 被删行 → 删 audio_assets）。
 * 说话人不存在 → 404；行引用失效（已删/他集/同提交内先删后用）→ 409；reorder 非排列 → 400。
 */
export async function applyChanges(
  db: Db,
  episodeId: string,
  ops: ScriptOp[],
  summary: string | null,
): Promise<ApplyChangesResult | null> {
  const applied = await db.transaction(async (tx) => {
    const [ep] = await tx
      .select({ id: episodes.id, wsId: episodes.wsId })
      .from(episodes)
      .where(eq(episodes.id, episodeId))
    if (!ep) return null

    await assertSpeakersExist(tx, ep.wsId, collectSpeakerIds(ops))

    const base: OpLine[] = await tx
      .select({
        id: scriptLines.id,
        serial: scriptLines.serial,
        speakerId: scriptLines.speakerId,
        text: scriptLines.text,
        instructions: scriptLines.instructions,
      })
      .from(scriptLines)
      .where(and(eq(scriptLines.episodeId, episodeId), eq(scriptLines.deleted, false)))

    // serial 数值序（字符串序 L1000 < L999 会排错）
    base.sort((a, b) => parseSerial(a.serial) - parseSerial(b.serial))

    const resolved = resolveOps(ops, () => randomUUID())
    const result = applyOps(base, resolved)
    const newSerialById = new Map(result.lines.map((line) => [line.id, line.serial]))
    const baseSerialById = new Map(base.map((line) => [line.id, line.serial]))
    const now = new Date()

    // 客户端预生成的 add id 不得与现有行或其他 add 相撞（否则插入时才炸 PK 冲突）
    const baseIds = new Set(base.map((line) => line.id))
    const addIds = result.addedIds
    if (addIds.some((id) => baseIds.has(id))) {
      throw new AppError('CONFLICT', 'add.id collides with an existing line', 409)
    }
    if (new Set(addIds).size !== addIds.length) {
      throw new AppError('BAD_REQUEST', 'duplicate add.id in ops', 400)
    }

    // 新增行：直接以最终 serial 落库
    const adds = resolved.filter((op): op is Extract<typeof op, { op: 'add' }> => op.op === 'add')
    if (adds.length > 0) {
      await tx.insert(scriptLines).values(
        adds.map((op) => ({
          id: op.id,
          episodeId,
          serial: newSerialById.get(op.id)!,
          speakerId: op.speakerId,
          text: op.text,
          instructions: op.instructions,
        })),
      )
    }

    // 编辑行：patch 全是文本层字段（speakerId/text/instructions）。
    // 引用不在最终工作集的行（同提交内先 edit 后 delete）直接跳过——该行随即被
    // 逻辑删除，永远不可见；先 delete 后 edit 则被 applyOps 以 409 拒绝。
    const serialTouched = new Set(result.addedIds)
    for (const op of resolved) {
      if (op.op !== 'edit') continue
      const serial = newSerialById.get(op.lineId)
      if (serial === undefined) continue
      await tx
        .update(scriptLines)
        .set({
          ...(op.patch.speakerId !== undefined && { speakerId: op.patch.speakerId }),
          ...(op.patch.text !== undefined && { text: op.patch.text }),
          ...(op.patch.instructions !== undefined && { instructions: op.patch.instructions }),
          serial,
          updatedAt: now,
        })
        .where(eq(scriptLines.id, op.lineId))
      serialTouched.add(op.lineId)
    }

    // 删除行：逻辑删除，id 永不复用
    const deletedIds = result.deletedIds
    if (deletedIds.length > 0) {
      await tx
        .update(scriptLines)
        .set({ deleted: true, updatedAt: now })
        .where(inArray(scriptLines.id, deletedIds))
    }

    // serial 重编：没被增/改触到、但顺序变了（删除/重排波及）的存活行
    const renumbered = result.lines.filter(
      (line) => !serialTouched.has(line.id) && baseSerialById.get(line.id) !== line.serial,
    )
    for (const line of renumbered) {
      await tx
        .update(scriptLines)
        .set({ serial: line.serial, updatedAt: now })
        .where(eq(scriptLines.id, line.id))
    }

    // 一提交一条 ChangeSet；base_version 仅作顺序计数（单用户，无乐观锁）
    const [countRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(changeSets)
      .where(eq(changeSets.episodeId, episodeId))
    const [cs] = await tx
      .insert(changeSets)
      .values({ episodeId, baseVersion: countRow?.count ?? 0, kind: 'user', summary })
      .returning({ id: changeSets.id })
    await tx.insert(changeSetOps).values(
      resolved.map((op, i) => ({
        csId: cs!.id,
        seq: i + 1,
        op: op.op,
        lineId: op.op === 'add' ? op.id : op.op === 'reorder' ? null : op.lineId,
        payload:
          op.op === 'add'
            ? { afterLineId: op.afterLineId, speakerId: op.speakerId, text: op.text, instructions: op.instructions }
            : op.op === 'edit'
              ? { patch: op.patch }
              : op.op === 'reorder'
                ? { lineIds: op.lineIds }
                : {},
      })),
    )

    // 作废受影响行素材：改台词/指令/说话人的存活行 + 被删行；纯 reorder/空 patch 不作废
    const invalidatedLineIds = [...new Set([...result.editedIds, ...result.deletedIds])]
    if (invalidatedLineIds.length > 0) {
      await tx.delete(audioAssets).where(inArray(audioAssets.scriptLineId, invalidatedLineIds))
    }

    return { changeSetId: cs!.id, invalidatedLineIds, summary }
  })

  if (!applied) return null
  // 新脚本投影在事务提交后读（单用户，无并发写者），避免事务句柄穿透类型
  const lines = await scriptLineViews(db, episodeId)
  return { ...applied, lines }
}

function collectSpeakerIds(ops: ScriptOp[]): string[] {
  const ids = new Set<string>()
  for (const op of ops) {
    if (op.op === 'add') ids.add(op.speakerId)
    if (op.op === 'edit' && op.patch.speakerId !== undefined) ids.add(op.patch.speakerId)
  }
  return [...ids]
}

async function assertSpeakersExist(tx: Tx, wsId: string, speakerIds: string[]) {
  if (speakerIds.length === 0) return
  const found = await tx
    .select({ id: speakers.id })
    .from(speakers)
    .where(and(eq(speakers.wsId, wsId), inArray(speakers.id, speakerIds)))
  if (found.length !== speakerIds.length) {
    throw new AppError('NOT_FOUND', 'speaker not found', 404)
  }
}

// ---- 后期参数（ADR-0004）：直接写，不经确认门、不追加 ChangeSet ----

export interface PostRulesPatch {
  pause?: PauseLevel
  speed?: SpeedLevel
}

export async function updatePostRules(
  db: Db,
  episodeId: string,
  patch: PostRulesPatch,
): Promise<{ pause: PauseLevel; speed: SpeedLevel } | null> {
  const [row] = await db
    .update(postRules)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(postRules.episodeId, episodeId))
    .returning({ pause: postRules.pause, speed: postRules.speed })
  if (!row) return null
  return { pause: row.pause as PauseLevel, speed: row.speed as SpeedLevel }
}

export interface LinePostPatch {
  pause?: PauseLevel | null
  speed?: SpeedLevel | null
}

/** 逐行覆盖；字段给 null 清除该行覆盖（回退集级默认）。行不存在/已删 → null（404） */
export async function updateLinePost(
  db: Db,
  episodeId: string,
  lineId: string,
  patch: LinePostPatch,
): Promise<LinePost | null> {
  const [line] = await db
    .select({ id: scriptLines.id, post: scriptLines.post })
    .from(scriptLines)
    .where(
      and(
        eq(scriptLines.id, lineId),
        eq(scriptLines.episodeId, episodeId),
        eq(scriptLines.deleted, false),
      ),
    )
  if (!line) return null

  const post: Record<string, unknown> = { ...((line.post ?? {}) as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete post[key]
    else post[key] = value
  }
  const [row] = await db
    .update(scriptLines)
    .set({ post: post as LinePost, updatedAt: new Date() })
    .where(eq(scriptLines.id, lineId))
    .returning({ post: scriptLines.post })
  return (row?.post ?? {}) as LinePost
}
