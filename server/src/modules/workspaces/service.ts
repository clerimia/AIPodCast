// 工作间配置服务（#19 表 1）：工作间 / 节目元数据 / 说话人 / 单集 CRUD。
// 职责边界（docs/modules-and-phasing.md）：不碰脚本 / 音频 / 会话；
// 建单集只连带 conversations(kind=writer) + post_rules 默认行。
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from '../../db/client.js'
import {
  artifacts,
  conversations,
  episodes,
  postRules,
  scriptLines,
  showMetadata,
  speakers,
  workspaces,
} from '../../db/schema.js'

export interface ShowMetadataInput {
  outline?: string
  topic?: string
  tone?: string
  terms?: string
  bannedWords?: string
  intro?: string
}

export interface SpeakerCreateInput {
  name: string
  persona?: string
  gender?: string
  voice: string
}

export interface SpeakerPatchInput {
  name?: string
  persona?: string
  gender?: string
  voice?: string
}

// ---- 工作间 ----

export async function listWorkspaces(db: Db) {
  return db
    .select({ id: workspaces.id, name: workspaces.name, createdAt: workspaces.createdAt })
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt))
}

/** 建工作间，连带 show_metadata 默认行（六个字段空串） */
export async function createWorkspace(db: Db, input: { name: string }) {
  return db.transaction(async (tx) => {
    const [ws] = await tx
      .insert(workspaces)
      .values({ name: input.name })
      .returning({ id: workspaces.id, name: workspaces.name, createdAt: workspaces.createdAt })
    await tx.insert(showMetadata).values({ wsId: ws!.id })
    return ws
  })
}

/** 详情一次拉全：show_metadata + speakers（工作间设置页一次取数，#19） */
export async function getWorkspace(db: Db, wsId: string) {
  const [ws] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, wsId))
  if (!ws) return null

  const [meta] = await db.select().from(showMetadata).where(eq(showMetadata.wsId, wsId))
  const speakerRows = await db
    .select(speakerColumns)
    .from(speakers)
    .where(eq(speakers.wsId, wsId))
    .orderBy(asc(speakers.createdAt))

  return {
    ...ws,
    showMetadata: {
      outline: meta?.outline ?? '',
      topic: meta?.topic ?? '',
      tone: meta?.tone ?? '',
      terms: meta?.terms ?? '',
      bannedWords: meta?.bannedWords ?? '',
      intro: meta?.intro ?? '',
    },
    speakers: speakerRows,
  }
}

// ---- 节目元数据 ----

/** PUT 语义下字段可省略 = 不改（前端表单整单发，省略字段仅为对 API 宽容） */
export async function updateShowMetadata(db: Db, wsId: string, input: ShowMetadataInput) {
  const set: ShowMetadataInput = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) set[key as keyof ShowMetadataInput] = value
  }
  const [row] = await db
    .update(showMetadata)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(showMetadata.wsId, wsId))
    .returning({
      outline: showMetadata.outline,
      topic: showMetadata.topic,
      tone: showMetadata.tone,
      terms: showMetadata.terms,
      bannedWords: showMetadata.bannedWords,
      intro: showMetadata.intro,
    })
  return row ?? null
}

// ---- 说话人 ----

// 四处（详情/列表/建/改）共用的说话人投影
const speakerColumns = {
  id: speakers.id,
  name: speakers.name,
  persona: speakers.persona,
  gender: speakers.gender,
  voice: speakers.voice,
}

async function workspaceExists(db: Db, wsId: string) {
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, wsId))
  return ws !== undefined
}

/** 工作间不存在 → null（路由映射 404） */
export async function listSpeakers(db: Db, wsId: string) {
  if (!(await workspaceExists(db, wsId))) return null
  return db.select(speakerColumns).from(speakers).where(eq(speakers.wsId, wsId)).orderBy(asc(speakers.createdAt))
}

export async function createSpeaker(db: Db, wsId: string, input: SpeakerCreateInput) {
  return db.transaction(async (tx) => {
    const [ws] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, wsId))
    if (!ws) return null
    const [row] = await tx
      .insert(speakers)
      .values({
        wsId,
        name: input.name,
        persona: input.persona ?? '',
        gender: input.gender ?? '',
        voice: input.voice,
      })
      .returning(speakerColumns)
    return row
  })
}

export async function updateSpeaker(
  db: Db,
  wsId: string,
  speakerId: string,
  input: SpeakerPatchInput,
) {
  const set: SpeakerPatchInput = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) set[key as keyof SpeakerPatchInput] = value
  }
  const [row] = await db
    .update(speakers)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(speakers.id, speakerId), eq(speakers.wsId, wsId)))
    .returning(speakerColumns)
  return row ?? null
}

export type DeleteSpeakerResult = 'not_found' | 'referenced' | 'deleted'

/**
 * 删说话人。被 script_lines 引用（含逻辑删除行——外键仍在）→ 'referenced'，由路由
 * 映射 409 CONFLICT「先改绑再删」；引用计数放在事务里与删除一起做，避免竞态。
 */
export async function deleteSpeaker(
  db: Db,
  wsId: string,
  speakerId: string,
): Promise<DeleteSpeakerResult> {
  return db.transaction(async (tx) => {
    const [speaker] = await tx
      .select({ id: speakers.id })
      .from(speakers)
      .where(and(eq(speakers.id, speakerId), eq(speakers.wsId, wsId)))
    if (!speaker) return 'not_found'

    const refs = await tx
      .select({ id: scriptLines.id })
      .from(scriptLines)
      .where(eq(scriptLines.speakerId, speakerId))
      .limit(1)
    if (refs.length > 0) return 'referenced'

    await tx.delete(speakers).where(eq(speakers.id, speakerId))
    return 'deleted'
  })
}

// ---- 单集 ----

/** 工作间不存在 → null（路由映射 404） */
export async function listEpisodes(db: Db, wsId: string) {
  if (!(await workspaceExists(db, wsId))) return null
  return db
    .select({
      id: episodes.id,
      wsId: episodes.wsId,
      title: episodes.title,
      showNotes: episodes.showNotes,
      createdAt: episodes.createdAt,
    })
    .from(episodes)
    .where(eq(episodes.wsId, wsId))
    .orderBy(desc(episodes.createdAt))
}

/** 建单集，连带 conversations(kind=writer) 行 + post_rules 默认行（中/正常） */
export async function createEpisode(db: Db, wsId: string, input: { title: string }) {
  return db.transaction(async (tx) => {
    const [ws] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, wsId))
    if (!ws) return null
    const [ep] = await tx
      .insert(episodes)
      .values({ wsId, title: input.title })
      .returning({
        id: episodes.id,
        wsId: episodes.wsId,
        title: episodes.title,
        showNotes: episodes.showNotes,
        createdAt: episodes.createdAt,
      })
    await tx.insert(conversations).values({ episodeId: ep!.id, kind: 'writer' })
    await tx.insert(postRules).values({ episodeId: ep!.id })
    return ep
  })
}

/**
 * 硬删单集。事务内：删 episode 行（外键级联带走 script_lines / audio_assets /
 * change_sets/change_set_ops / conversations / post_rules / synthesis_jobs /
 * artifacts / messages 等所有附属）。事务提交后：rm `MEDIA_ROOT/ws-{wsId}/ep-{id}`
 * 整个目录（assets + artifacts 落盘文件）。
 *
 * 失败语义：
 *   - 'not_found'  工作间或单集不存在
 *   - 'has_artifact' 已有产物（master.mp3）— 仍删，但路由层返 409 让前端用更重的 UI 二次确认
 *   - 'deleted'   成功；目录清理失败不抛（孤儿文件不影响正确性，DB 已删）
 *
 * 媒体目录清理是 best-effort：rm 失败仅记入服务端日志，不影响 API 返回。uuid 永不
 * 复用（drizzle .defaultRandom() + FK 残留保护），孤儿目录不会撞到未来同名 episode。
 */
export type DeleteEpisodeResult = 'not_found' | 'has_artifact' | 'deleted'

export async function deleteEpisode(
  db: Db,
  mediaRoot: string,
  wsId: string,
  episodeId: string,
): Promise<DeleteEpisodeResult> {
  const result = await db.transaction(async (tx) => {
    const [ep] = await tx
      .select({ id: episodes.id })
      .from(episodes)
      .where(and(eq(episodes.id, episodeId), eq(episodes.wsId, wsId)))
    if (!ep) return 'not_found' as const

    // 提前探一下有没有产物（artifacts 行）；有则先标，删完再返回让路由决定
    const [art] = await tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.episodeId, episodeId))
      .limit(1)

    await tx.delete(episodes).where(eq(episodes.id, episodeId))
    return art ? ('has_artifact' as const) : ('deleted' as const)
  })

  if (result === 'not_found') return result

  // 事务提交后再清目录；失败不抛（orphan file 留底，DB 不会再有引用）
  const epDir = join(mediaRoot, `ws-${wsId}`, `ep-${episodeId}`)
  try {
    await rm(epDir, { recursive: true, force: true })
  } catch {
    // 吞掉：单集已从 DB 删干净；落盘文件孤儿不影响功能（uuid 不复用）
  }
  return result
}

/** 列单集时同时统计「是否有产物」——前端删除按钮需要警示 */
export interface EpisodeWithArtifact {
  id: string
  wsId: string
  title: string
  showNotes: string
  createdAt: Date
  hasArtifact: boolean
}

export async function listEpisodesWithArtifact(db: Db, wsId: string): Promise<EpisodeWithArtifact[] | null> {
  if (!(await workspaceExists(db, wsId))) return null
  // 一次查询拿齐 has_artifact：EXISTS 子查询（drizzle 的 sql 模板参数内插风格与同模块
  // listResources 一致；参数化天然免注入）。
  const rows = await db.execute(sql`
    SELECT e.id, e.ws_id, e.title, e.show_notes, e.created_at,
           EXISTS(SELECT 1 FROM artifacts a WHERE a.episode_id = e.id) AS has_artifact
    FROM episodes e
    WHERE e.ws_id = ${wsId}
    ORDER BY e.created_at DESC
  `)
  return (rows as unknown as Array<{
    id: string
    ws_id: string
    title: string
    show_notes: string
    created_at: Date
    has_artifact: boolean
  }>).map((r) => ({
    id: String(r.id),
    wsId: String(r.ws_id),
    title: String(r.title),
    showNotes: String(r.show_notes),
    createdAt: r.created_at as Date,
    hasArtifact: Boolean(r.has_artifact),
  }))
}
