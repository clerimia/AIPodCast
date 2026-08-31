// drizzle 全表，对照 docs/data-model-draft.md（M0 只建有业务路径的 11 张；
// 不建 messages（地图出界）与 asset_library（素材库出界，ADR-0006 预留在文档层））。
// casing: 'snake_case'（见 drizzle.config.ts 与 client.ts）。
import { relations } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

// ---- 工作间配置 ----

export const workspaces = pgTable('workspaces', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// 节目元数据：工作间级常驻设置（大纲/主题/口吻/术语/禁词/节目简介），一工作间 0..1
export const showMetadata = pgTable('show_metadata', {
  id: uuid().primaryKey().defaultRandom(),
  wsId: uuid('ws_id')
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  outline: text().notNull().default(''),
  topic: text().notNull().default(''),
  tone: text().notNull().default(''),
  terms: text().notNull().default(''),
  bannedWords: text('banned_words').notNull().default(''),
  intro: text().notNull().default(''),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// 说话人：名称 + 人设 + 性别 + 音色（24 系统音色名之一，M1 校验）
export const speakers = pgTable('speakers', {
  id: uuid().primaryKey().defaultRandom(),
  wsId: uuid('ws_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  persona: text().notNull().default(''),
  gender: text().notNull().default(''),
  voice: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// ---- 文本层：脚本（活单层文本，ADR-0001）----

export const episodes = pgTable('episodes', {
  id: uuid().primaryKey().defaultRandom(),
  wsId: uuid('ws_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  // 单集简介：单集级活文本（ADR-0009 源头活字段），合成时快照进产物 notes.md
  showNotes: text('show_notes').notNull().default(''),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// 脚本行 = 说话人 + 台词 + 指令；id 永不复用，删除是 deleted=true，serial（L001…）按序重编
export const scriptLines = pgTable(
  'script_lines',
  {
    id: uuid().primaryKey().defaultRandom(),
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    serial: text().notNull(),
    // 说话人被引用时删不得（应用层 409 CONFLICT），故不级联
    speakerId: uuid('speaker_id')
      .notNull()
      .references(() => speakers.id),
    text: text().notNull(),
    // 指令：语气/情感/风格（引擎 input.instructions）
    instructions: text().notNull().default(''),
    // 逐行后期覆盖（停顿/语速档位）；空对象 = 用集级 post_rules
    post: jsonb().notNull().default({}),
    deleted: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('script_lines_episode_serial_idx').on(t.episodeId, t.serial)],
)

// 暂存/确认门（ADR-0003）：一次提交一条 ChangeSet；base_version 仅作顺序计数（单用户，不做乐观锁）
export const changeSets = pgTable('change_sets', {
  id: uuid().primaryKey().defaultRandom(),
  episodeId: uuid('episode_id')
    .notNull()
    .references(() => episodes.id, { onDelete: 'cascade' }),
  baseVersion: integer('base_version').notNull().default(0),
  kind: text().notNull().default('user'),
  summary: text(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
})

export const changeSetOps = pgTable('change_set_ops', {
  id: uuid().primaryKey().defaultRandom(),
  csId: uuid('cs_id')
    .notNull()
    .references(() => changeSets.id, { onDelete: 'cascade' }),
  seq: integer().notNull(),
  // add | edit | delete | reorder
  op: text().notNull(),
  // 目标行；reorder 的全序在 payload.lineIds，lineId 为 null
  lineId: uuid('line_id'),
  payload: jsonb().notNull().default({}),
})

// ---- 资源层：工作间知识库（知识摄入与检索设计 2026-08-31）----

// 资源：工作间级可检索资料；content_md（markitdown 转换产物）是切块与替换的唯一真相源
export const resources = pgTable('resources', {
  id: uuid().primaryKey().defaultRandom(),
  wsId: uuid('ws_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  // md | txt | docx | pdf | paste
  kind: text().notNull(),
  contentMd: text('content_md').notNull(),
  // sha256(content_md)：同工作间重复摄入提示用
  contentHash: text('content_hash').notNull(),
  charCount: integer('char_count').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// 资源切块（检索单位）：标题路径 + 块文本 + 可空向量。
// embedding 失败/离线置 NULL——BM25 通道不受影响（检索层开关与摄入层解耦，设计定案）
export const resourceChunks = pgTable(
  'resource_chunks',
  {
    id: uuid().primaryKey().defaultRandom(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resources.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    // 标题路径（「第一章 > 1.1 背景」）；无标题文档为空串
    heading: text().notNull().default(''),
    content: text().notNull(),
    // 1024 = text-embedding-v4 维度；不建 ANN 索引（小语料精确余弦 <=>）
    embedding: vector({ dimensions: 1024 }),
    createdAt: createdAt(),
  },
  (t) => [index('resource_chunks_resource_seq_idx').on(t.resourceId, t.seq)],
)

// ---- 音频层：素材 / 后期规则 / 会话 / 产物 ----

// 音频素材：每脚本行 0..1 份（UNIQUE，跟随脚本行，ADR-0006）；audio_ref 相对 MEDIA_ROOT
export const audioAssets = pgTable('audio_assets', {
  id: uuid().primaryKey().defaultRandom(),
  scriptLineId: uuid('script_line_id')
    .notNull()
    .unique()
    .references(() => scriptLines.id, { onDelete: 'cascade' }),
  audioRef: text('audio_ref').notNull(),
  durationMs: integer('duration_ms'),
  createdAt: createdAt(),
})

// 集级后期默认规则（停顿档位/语速档位，ADR-0004）；建单集连带默认行 中/正常
export const postRules = pgTable('post_rules', {
  id: uuid().primaryKey().defaultRandom(),
  episodeId: uuid('episode_id')
    .notNull()
    .unique()
    .references(() => episodes.id, { onDelete: 'cascade' }),
  // 短 | 中 | 长
  pause: text().notNull().default('中'),
  // 慢 | 正常 | 快
  speed: text().notNull().default('正常'),
  updatedAt: updatedAt(),
})

// 写稿大师会话（ADR-0005）：一集一个（kind=writer）；session_file 首次会话时回填
export const conversations = pgTable('conversations', {
  id: uuid().primaryKey().defaultRandom(),
  episodeId: uuid('episode_id')
    .notNull()
    .references(() => episodes.id, { onDelete: 'cascade' }),
  kind: text().notNull().default('writer'),
  sessionFile: text('session_file'),
  createdAt: createdAt(),
})

// 任务失败信息（docs/synthesis-progress-and-cancel.md）：三个 SYNTH_* 错误码 + 重启中断
export interface JobError {
  code: string
  message: string
  lineId?: string
  serial?: string
}

// 合成任务（#28 重新讨论定案）：整集合成的异步执行留痕，任务创建插行、状态迁移落库。
// 可持久化状态在 DB；运行期句柄（AbortController/取消旗标）留进程内（synthesis/jobs.ts）。
// 重启时非终态孤儿行标 interrupted（终态，不自动续跑）。
export const synthesisJobs = pgTable(
  'synthesis_jobs',
  {
    id: uuid().primaryKey().defaultRandom(),
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    // pending|running|canceling|succeeded|failed|canceled|interrupted（M5 产生前四 + interrupted）
    status: text().notNull().default('pending'),
    // tts|post|encode|verify|null（pending 时 null；终态定格在最后所处阶段）
    stage: text(),
    // 启动时快照的有序 lineIds（非删除行按 serial 序）
    plan: jsonb().$type<string[]>().notNull().default([]),
    // 累积已完成行（含命中复用）
    doneLineIds: jsonb('done_line_ids').$type<string[]>().notNull().default([]),
    currentLine: jsonb('current_line').$type<{ lineId: string; serial: string } | null>(),
    // { code, message, lineId?, serial? } | null
    error: jsonb().$type<JobError | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('synthesis_jobs_episode_idx').on(t.episodeId),
    // 同一单集同时只允许一个活跃任务（并发守卫的后备：路由层先查，冲突时唯一索引兜底）
    uniqueIndex('synthesis_jobs_active_unique')
      .on(t.episodeId)
      .where(sql`status IN ('pending', 'running', 'canceling')`),
  ],
)

// 产物：一集 0..1，重新合成整包替换（验证失败保留旧产物，ADR-0007）
export const artifacts = pgTable('artifacts', {
  id: uuid().primaryKey().defaultRandom(),
  episodeId: uuid('episode_id')
    .notNull()
    .unique()
    .references(() => episodes.id, { onDelete: 'cascade' }),
  kind: text().notNull().default('master'),
  audioRef: text('audio_ref').notNull(),
  transcriptRef: text('transcript_ref'),
  notesRef: text('notes_ref'),
  durationMs: integer('duration_ms'),
  size: bigint('size', { mode: 'number' }),
  createdAt: createdAt(),
})

// ---- 关系（供 drizzle relational query；M0 只声明，不产生查询路径）----
// 惯例：带外键的一侧声明 fields/references，另一侧裸 one()/many() 反推。

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  speakers: many(speakers),
  episodes: many(episodes),
  resources: many(resources),
}))

export const showMetadataRelations = relations(showMetadata, ({ one }) => ({
  workspace: one(workspaces, { fields: [showMetadata.wsId], references: [workspaces.id] }),
}))

export const speakersRelations = relations(speakers, ({ one }) => ({
  workspace: one(workspaces, { fields: [speakers.wsId], references: [workspaces.id] }),
}))

export const episodesRelations = relations(episodes, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [episodes.wsId], references: [workspaces.id] }),
  scriptLines: many(scriptLines),
  changeSets: many(changeSets),
  conversations: many(conversations),
}))

export const scriptLinesRelations = relations(scriptLines, ({ one }) => ({
  episode: one(episodes, { fields: [scriptLines.episodeId], references: [episodes.id] }),
  speaker: one(speakers, { fields: [scriptLines.speakerId], references: [speakers.id] }),
  audioAsset: one(audioAssets),
}))

export const audioAssetsRelations = relations(audioAssets, ({ one }) => ({
  scriptLine: one(scriptLines, {
    fields: [audioAssets.scriptLineId],
    references: [scriptLines.id],
  }),
}))

export const changeSetsRelations = relations(changeSets, ({ one, many }) => ({
  episode: one(episodes, { fields: [changeSets.episodeId], references: [episodes.id] }),
  ops: many(changeSetOps),
}))

export const changeSetOpsRelations = relations(changeSetOps, ({ one }) => ({
  changeSet: one(changeSets, { fields: [changeSetOps.csId], references: [changeSets.id] }),
}))

export const postRulesRelations = relations(postRules, ({ one }) => ({
  episode: one(episodes, { fields: [postRules.episodeId], references: [episodes.id] }),
}))

export const conversationsRelations = relations(conversations, ({ one }) => ({
  episode: one(episodes, { fields: [conversations.episodeId], references: [episodes.id] }),
}))

export const artifactsRelations = relations(artifacts, ({ one }) => ({
  episode: one(episodes, { fields: [artifacts.episodeId], references: [episodes.id] }),
}))

export const resourcesRelations = relations(resources, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [resources.wsId], references: [workspaces.id] }),
  chunks: many(resourceChunks),
}))

export const resourceChunksRelations = relations(resourceChunks, ({ one }) => ({
  resource: one(resources, { fields: [resourceChunks.resourceId], references: [resources.id] }),
}))
