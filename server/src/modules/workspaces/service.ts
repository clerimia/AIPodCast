// 工作间配置服务（#19 表 1）：工作间 / 节目元数据 / 说话人 / 单集 CRUD。
// 职责边界（docs/modules-and-phasing.md）：不碰脚本 / 音频 / 会话；
// 建单集只连带 conversations(kind=writer) + post_rules 默认行。
import { and, asc, desc, eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import {
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
