// DashScope text-embedding-v4（OpenAI 兼容端点）批量 embedding。
// best-effort 语义（设计定案）：任何失败（缺 key / 非 2xx（含 403 额度用尽）/ 超时 /
// 形状异常）一律返 null 而非抛错——摄入时该批块 embedding 置 NULL（BM25 不受影响），
// 检索时跳过向量通道。批量上限：官方限额 10；Task 1 spike 2 时测试账号 403
// 额度用尽未能实测，留余量保守取 6。
import { env } from '../../env.js'

export const EMBED_MODEL = 'text-embedding-v4'
export const EMBED_DIMENSIONS = 1024
export const EMBED_BATCH_SIZE = 6

/** Stub embedder：所有块的 embedding 一律 NULL。摄入用——让"切块+落库"与
 *  "调 DashScope"解耦；状态自然进入 'pending'，等用户在前端点"向量化"再跑真
 *  embed。永远返非 null 数组（每项都是 null），与 DashscopeEmbedder 失败时
 *  返 null 区分开，便于 service 派生 embeddingStatus。 */
export function makeNullEmbedder(): Embedder {
  return {
    async embed(texts): Promise<number[][]> {
      return new Array(texts.length).fill(null) as number[][]
    },
  }
}

export interface Embedder {
  /** 返回与 texts 等长同序的向量；null = 本批失败（调用方降级） */
  embed(texts: string[]): Promise<number[][] | null>
}

export interface DashscopeEmbedOptions {
  fetchImpl?: typeof fetch
  /** 缺省读 env.dashscopeApiKey；显式传 null = 无凭证（测试缺失分支用） */
  apiKey?: string | null
  /** 缺省读 env.dashscopeBaseUrl，再缺省官方主机 */
  baseUrl?: string | null
  timeoutMs?: number
}

export function makeDashscopeEmbedder(options: DashscopeEmbedOptions = {}): Embedder {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  return {
    async embed(texts) {
      if (texts.length === 0) return []
      const apiKey = options.apiKey !== undefined ? options.apiKey : env.dashscopeApiKey
      if (!apiKey) return null
      // BASE_URL 只填主机（与写稿/TTS 共用）；嵌入走 compatible-mode 端点
      const base = (options.baseUrl ?? env.dashscopeBaseUrl ?? 'https://dashscope.aliyuncs.com').replace(/\/+$/, '')
      try {
        const res = await fetchImpl(`${base}/compatible-mode/v1/embeddings`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMENSIONS }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) return null
        const payload = (await res.json()) as { data?: { embedding: number[]; index: number }[] }
        const data = payload.data
        if (!Array.isArray(data) || data.length !== texts.length) return null
        const sorted = [...data].sort((a, b) => a.index - b.index)
        if (sorted.some((d) => !Array.isArray(d.embedding) || d.embedding.length !== EMBED_DIMENSIONS)) return null
        return sorted.map((d) => d.embedding)
      } catch {
        return null
      }
    },
  }
}

/** 批量嵌入：按 EMBED_BATCH_SIZE 切批，批失败不阻断——对应块向量为 null */
export async function embedChunks(
  embedder: Embedder,
  texts: string[],
): Promise<{ vectors: (number[] | null)[]; failedCount: number }> {
  const vectors: (number[] | null)[] = new Array(texts.length).fill(null)
  let failedCount = 0
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE)
    const result = await embedder.embed(batch)
    if (result === null) {
      failedCount += batch.length
      continue
    }
    for (let j = 0; j < batch.length; j++) vectors[i + j] = result[j]!
  }
  return { vectors, failedCount }
}
