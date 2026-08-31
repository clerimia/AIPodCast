// 检索服务：BM25（pg_search）+ 向量（pgvector 精确余弦）双通道，应用侧 RRF 融合。
// 开关在检索层：mode 缺省读 env.retrievalMode；向量通道失败/无向量自动退化为纯
// BM25，不报错。空库短路返回引导语状态（防模型反复空检索，同说话人清单手法）。
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { resources } from '../../db/schema.js'
import { env } from '../../env.js'
import { makeDashscopeEmbedder, type Embedder } from './embed.js'

export const BM25_TOP_K = 20
export const VECTOR_TOP_K = 20
export const RRF_K = 60
export const RESULT_LIMIT = 5

export interface RetrievalHit {
  chunkId: string
  resourceTitle: string
  heading: string
  content: string
}

export interface RetrieveResult {
  status: 'empty_library' | 'no_hits' | 'ok'
  hits: RetrievalHit[]
}

export interface RetrieveOptions {
  mode?: 'hybrid' | 'bm25'
  /** 缺省现造（生产路径）；测试注入 stub */
  embedder?: Embedder
  resultLimit?: number
}

/** RRF 融合（纯函数）：通道 = 按相关性降序的 chunkId 列表；score = Σ 1/(60+rank)，rank 从 1 起 */
export function fuseRrf(channels: string[][]): string[] {
  const score = new Map<string, number>()
  for (const channel of channels) {
    channel.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1))
    })
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

/** tantivy 查询语法特殊字符清洗：用户文本按纯词处理 */
export function sanitizeQuery(query: string): string {
  return query
    .replace(/[+\-=&|><!()[\]{}^"~*?:\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 工具结果格式：《资源标题》> 标题路径：块文本 */
export function formatHits(hits: RetrievalHit[]): string {
  return hits
    .map((h) => `《${h.resourceTitle}》${h.heading ? `> ${h.heading}` : ''}：${h.content}`)
    .join('\n\n')
}

async function bm25Channel(db: Db, wsId: string, query: string, limit: number): Promise<RetrievalHit[]> {
  // pg_search 0.25.4 形状（Task 1 spike 1 验证）：match 走 key_field（id），
  // score 也按 id 取；旧 `content @@@ '词'` + `paradedb.score('索引名')` 在该版本不可用
  const rows = await db.execute(sql`
    SELECT c.id, c.heading, c.content, r.title AS resource_title,
           paradedb.score(c.id) AS score
    FROM resource_chunks c
    JOIN resources r ON r.id = c.resource_id
    WHERE r.ws_id = ${wsId} AND c.id @@@ paradedb.match('content', ${query})
    ORDER BY score DESC
    LIMIT ${limit}`)
  return rows.map((r) => ({
    chunkId: String(r.id),
    resourceTitle: String(r.resource_title),
    heading: String(r.heading),
    content: String(r.content),
  }))
}

async function vectorChannel(
  db: Db,
  wsId: string,
  embedding: number[],
  limit: number,
): Promise<RetrievalHit[]> {
  const literal = `[${embedding.join(',')}]`
  const rows = await db.execute(sql`
    SELECT c.id, c.heading, c.content, r.title AS resource_title,
           c.embedding <=> ${literal}::vector AS distance
    FROM resource_chunks c
    JOIN resources r ON r.id = c.resource_id
    WHERE r.ws_id = ${wsId} AND c.embedding IS NOT NULL
    ORDER BY distance ASC
    LIMIT ${limit}`)
  return rows.map((r) => ({
    chunkId: String(r.id),
    resourceTitle: String(r.resource_title),
    heading: String(r.heading),
    content: String(r.content),
  }))
}

export async function retrieve(
  db: Db,
  wsId: string,
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const [ws] = await db.select({ id: resources.id }).from(resources).where(eq(resources.wsId, wsId)).limit(1)
  if (!ws) return { status: 'empty_library', hits: [] }

  const q = sanitizeQuery(query)
  if (q === '') return { status: 'no_hits', hits: [] }

  const mode = opts.mode ?? env.retrievalMode
  const channels: RetrievalHit[][] = [await bm25Channel(db, wsId, q, BM25_TOP_K)]
  if (mode === 'hybrid') {
    const embedder = opts.embedder ?? makeDashscopeEmbedder()
    const vector = (await embedder.embed([query]))?.[0] ?? null
    if (vector !== null) {
      channels.push(await vectorChannel(db, wsId, vector, VECTOR_TOP_K))
    }
  }

  const fused = fuseRrf(channels.map((c) => c.map((h) => h.chunkId)))
  const byId = new Map<string, RetrievalHit>()
  for (const channel of channels) for (const hit of channel) byId.set(hit.chunkId, hit)
  const hits = fused
    .map((id) => byId.get(id))
    .filter((h): h is RetrievalHit => h !== undefined)
    .slice(0, opts.resultLimit ?? RESULT_LIMIT)
  return hits.length > 0 ? { status: 'ok', hits } : { status: 'no_hits', hits: [] }
}
