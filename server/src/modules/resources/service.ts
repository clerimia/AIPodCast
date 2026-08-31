// 资源服务：摄入编排（转换在路由层完成——先转换成功、后落库，不留脏数据）+
// 列表/详情/替换/删除。摄入与替换都是单事务（替换中途失败回滚，旧资源原样保留）。
// 依赖方向：只碰 db/ 与同模块纯函数；不 import writer/script/synthesis/post。
import { createHash } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { resourceChunks, resources, workspaces } from '../../db/schema.js'
import { AppError } from '../../shared/errors.js'
import { chunkMarkdown } from './chunk.js'
import { embedChunks, makeDashscopeEmbedder, type Embedder } from './embed.js'
import type { ResourceKind } from './convert.js'

export interface ResourceView {
  id: string
  title: string
  kind: string
  charCount: number
  chunkCount: number
  embeddedCount: number
  createdAt: Date
}

export interface ResourceDetail extends ResourceView {
  updatedAt: Date
  contentMd: string
}

export interface IngestInput {
  title: string
  kind: ResourceKind
  contentMd: string
}

export interface IngestResult {
  resource: { id: string; title: string; kind: string; charCount: number; createdAt: Date }
  chunkCount: number
  /** embedding 部分失败提示；全成功为 null */
  embedWarning: string | null
  /** 同工作间已存在同内容资源的标题；无重复为 null（不阻断，尊重用户决定） */
  duplicateTitle: string | null
}

export interface ServiceDeps {
  /** 缺省现造（生产路径读 env 凭证）；buildApp 注入 stub 供测试 */
  embedder?: Embedder
}

async function workspaceExists(db: Db, wsId: string): Promise<boolean> {
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, wsId))
  return ws !== undefined
}

/** 工作间不存在 → null（路由映射 404） */
export async function listResources(db: Db, wsId: string): Promise<ResourceView[] | null> {
  if (!(await workspaceExists(db, wsId))) return null
  const rows = await db.execute(sql`
    SELECT r.id, r.title, r.kind, r.char_count, r.created_at,
           count(c.id)::int AS chunk_count,
           count(c.embedding)::int AS embedded_count
    FROM resources r
    LEFT JOIN resource_chunks c ON c.resource_id = r.id
    WHERE r.ws_id = ${wsId}
    GROUP BY r.id
    ORDER BY r.created_at DESC`)
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    kind: String(r.kind),
    charCount: Number(r.char_count),
    chunkCount: Number(r.chunk_count),
    embeddedCount: Number(r.embedded_count),
    createdAt: r.created_at as Date,
  }))
}

/** 资源不存在或不属于该工作间 → null（路由映射 404） */
export async function getResource(db: Db, wsId: string, resourceId: string): Promise<ResourceDetail | null> {
  const rows = await db.execute(sql`
    SELECT r.id, r.title, r.kind, r.char_count, r.content_md, r.created_at, r.updated_at,
           count(c.id)::int AS chunk_count,
           count(c.embedding)::int AS embedded_count
    FROM resources r
    LEFT JOIN resource_chunks c ON c.resource_id = r.id
    WHERE r.id = ${resourceId} AND r.ws_id = ${wsId}
    GROUP BY r.id`)
  const r = rows[0]
  if (!r) return null
  return {
    id: String(r.id),
    title: String(r.title),
    kind: String(r.kind),
    charCount: Number(r.char_count),
    chunkCount: Number(r.chunk_count),
    embeddedCount: Number(r.embedded_count),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    contentMd: String(r.content_md),
  }
}

/** 切块 + 嵌入的事务外准备（网络不进事务）；空内容 → 400 */
async function prepare(
  contentMd: string,
  deps: ServiceDeps,
): Promise<{
  chunks: ReturnType<typeof chunkMarkdown>
  vectors: (number[] | null)[]
  failedCount: number
  contentHash: string
}> {
  if (contentMd.trim() === '') {
    throw new AppError('BAD_REQUEST', '内容为空，没有可入库的文本', 400)
  }
  const chunks = chunkMarkdown(contentMd)
  if (chunks.length === 0) {
    throw new AppError('BAD_REQUEST', '内容为空，没有可入库的文本', 400)
  }
  const embedder = deps.embedder ?? makeDashscopeEmbedder()
  const { vectors, failedCount } = await embedChunks(embedder, chunks.map((c) => c.content))
  const contentHash = createHash('sha256').update(contentMd).digest('hex')
  return { chunks, vectors, failedCount, contentHash }
}

// drizzle vector 列的插入类型是 number[] | null（mapToDriverValue 内部 JSON.stringify
// 成 Postgres 向量字面量），不能直接传字符串字面量。
function chunkValues(resourceId: string, chunks: ReturnType<typeof chunkMarkdown>, vectors: (number[] | null)[]) {
  return chunks.map((c, i) => ({
    resourceId,
    seq: c.seq,
    heading: c.heading,
    content: c.content,
    embedding: vectors[i] ?? null,
  }))
}

function makeResult(
  row: { id: string; title: string; kind: string; charCount: number; createdAt: Date },
  chunkCount: number,
  failedCount: number,
  duplicateTitle: string | null,
): IngestResult {
  return {
    resource: row,
    chunkCount,
    embedWarning: failedCount > 0 ? `已入库，但 ${failedCount} 个块未生成向量（检索仍可走全文通道）` : null,
    duplicateTitle,
  }
}

/** 工作间不存在 → null；空内容 → 400（调用方已保证转换成功） */
export async function ingestResource(
  db: Db,
  wsId: string,
  input: IngestInput,
  deps: ServiceDeps = {},
): Promise<IngestResult | null> {
  if (!(await workspaceExists(db, wsId))) return null
  const { chunks, vectors, failedCount, contentHash } = await prepare(input.contentMd, deps)

  const [dup] = await db
    .select({ title: resources.title })
    .from(resources)
    .where(and(eq(resources.wsId, wsId), eq(resources.contentHash, contentHash)))
    .limit(1)

  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(resources)
      .values({
        wsId,
        title: input.title,
        kind: input.kind,
        contentMd: input.contentMd,
        contentHash,
        charCount: input.contentMd.length,
      })
      .returning({
        id: resources.id,
        title: resources.title,
        kind: resources.kind,
        charCount: resources.charCount,
        createdAt: resources.createdAt,
      })
    await tx.insert(resourceChunks).values(chunkValues(inserted!.id, chunks, vectors))
    return inserted!
  })
  return makeResult(row, chunks.length, failedCount, dup?.title ?? null)
}

/** 显式替换：同摄入管道；单事务删旧块 + 更新资源行 + 写新块，中途失败整体回滚。
 *  标题缺省 = 沿用原标题。资源不存在 → 'not_found'（路由映射 404） */
export async function replaceResource(
  db: Db,
  wsId: string,
  resourceId: string,
  input: { title?: string; kind: ResourceKind; contentMd: string },
  deps: ServiceDeps = {},
): Promise<IngestResult | 'not_found'> {
  const { chunks, vectors, failedCount, contentHash } = await prepare(input.contentMd, deps)

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: resources.id, title: resources.title })
      .from(resources)
      .where(and(eq(resources.id, resourceId), eq(resources.wsId, wsId)))
    if (!existing) return 'not_found' as const

    await tx.delete(resourceChunks).where(eq(resourceChunks.resourceId, resourceId))
    const [updated] = await tx
      .update(resources)
      .set({
        title: input.title ?? existing.title,
        kind: input.kind,
        contentMd: input.contentMd,
        contentHash,
        charCount: input.contentMd.length,
        updatedAt: new Date(),
      })
      .where(eq(resources.id, resourceId))
      .returning({
        id: resources.id,
        title: resources.title,
        kind: resources.kind,
        charCount: resources.charCount,
        createdAt: resources.createdAt,
      })
    await tx.insert(resourceChunks).values(chunkValues(resourceId, chunks, vectors))
    return makeResult(updated!, chunks.length, failedCount, null)
  })
  return result
}

/** 删除（块由外键级联）；不存在 → false（路由映射 404） */
export async function deleteResource(db: Db, wsId: string, resourceId: string): Promise<boolean> {
  const deleted = await db
    .delete(resources)
    .where(and(eq(resources.id, resourceId), eq(resources.wsId, wsId)))
    .returning({ id: resources.id })
  return deleted.length > 0
}

/** 第六层资源清单（标题 + 字符数，上限 50 条防 prompt 膨胀） */
export async function listResourceTitles(db: Db, wsId: string): Promise<{ title: string; charCount: number }[]> {
  return db
    .select({ title: resources.title, charCount: resources.charCount })
    .from(resources)
    .where(eq(resources.wsId, wsId))
    .orderBy(desc(resources.createdAt))
    .limit(50)
}
