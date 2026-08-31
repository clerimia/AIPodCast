import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMBED_BATCH_SIZE, embedChunks, makeDashscopeEmbedder, type Embedder } from '../src/modules/resources/embed.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

/** n 维向量：第 i 维为 1 其余 0（测试里 n 固定 1024） */
const oneHot = (i: number, n = 1024) => {
  const v = new Array<number>(n).fill(0)
  v[i] = 1
  return v
}

test('成功：按 index 排序返回、维度校验通过', async () => {
  const seen: { url: string; body: unknown }[] = []
  const embedder = makeDashscopeEmbedder({
    apiKey: 'k',
    baseUrl: 'https://example.test',
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return jsonResponse(200, {
        data: [
          { index: 1, embedding: oneHot(1) },
          { index: 0, embedding: oneHot(0) },
        ],
      })
    }) as typeof fetch,
  })
  const result = await embedder.embed(['a', 'b'])
  assert.ok(result)
  assert.deepEqual(result[0], oneHot(0))
  assert.deepEqual(result[1], oneHot(1))
  // 端点 = BASE_URL/compatible-mode/v1/embeddings；请求带 dimensions=1024
  assert.equal(seen[0]!.url, 'https://example.test/compatible-mode/v1/embeddings')
  assert.equal((seen[0]!.body as { dimensions: number }).dimensions, 1024)
  assert.equal((seen[0]!.body as { model: string }).model, 'text-embedding-v4')
})

test('非 2xx / 网络错误 / 缺 key → null（best-effort 降级）', async () => {
  const failing = makeDashscopeEmbedder({
    apiKey: 'k',
    fetchImpl: (async () => jsonResponse(429, { error: { message: 'too many' } })) as typeof fetch,
  })
  assert.equal(await failing.embed(['a']), null)

  const throwing = makeDashscopeEmbedder({
    apiKey: 'k',
    fetchImpl: (async () => {
      throw new Error('network down')
    }) as typeof fetch,
  })
  assert.equal(await throwing.embed(['a']), null)

  const noKey = makeDashscopeEmbedder({ apiKey: null })
  assert.equal(await noKey.embed(['a']), null)
})

test('响应形状异常（条数不符 / 维度不符）→ null', async () => {
  const wrongCount = makeDashscopeEmbedder({
    apiKey: 'k',
    fetchImpl: (async () => jsonResponse(200, { data: [{ index: 0, embedding: oneHot(0) }] })) as typeof fetch,
  })
  assert.equal(await wrongCount.embed(['a', 'b']), null)

  const wrongDim = makeDashscopeEmbedder({
    apiKey: 'k',
    fetchImpl: (async () =>
      jsonResponse(200, { data: [{ index: 0, embedding: [1, 2, 3] }] })) as typeof fetch,
  })
  assert.equal(await wrongDim.embed(['a']), null)
})

test('空输入 → 空数组，不发请求', async () => {
  let called = 0
  const embedder = makeDashscopeEmbedder({
    apiKey: 'k',
    fetchImpl: (async () => {
      called++
      return jsonResponse(200, { data: [] })
    }) as typeof fetch,
  })
  assert.deepEqual(await embedder.embed([]), [])
  assert.equal(called, 0)
})

test('embedChunks：按批切分；失败批次置 null 且计数', async () => {
  const texts = Array.from({ length: EMBED_BATCH_SIZE + 2 }, (_, i) => `t${i}`)
  let call = 0
  const embedder: Embedder = {
    async embed(batch) {
      call++
      if (call === 2) return null // 第二批失败
      return batch.map((_, i) => oneHot(i))
    },
  }
  const { vectors, failedCount } = await embedChunks(embedder, texts)
  assert.equal(call, 2)
  assert.equal(failedCount, 2)
  for (let i = 0; i < EMBED_BATCH_SIZE; i++) assert.ok(vectors[i])
  assert.equal(vectors[EMBED_BATCH_SIZE], null)
  assert.equal(vectors[EMBED_BATCH_SIZE + 1], null)
})
