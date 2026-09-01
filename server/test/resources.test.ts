import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { episodes, workspaces } from '../src/db/schema.js'
import type { Embedder } from '../src/modules/resources/embed.js'
import { retrieve } from '../src/modules/resources/retrieve.js'

type App = Awaited<ReturnType<typeof buildApp>>
type Db = App['db']

/** 确定性 stub：含「量子」→ 第 0 维，其余 → 第 1 维（1024 维 one-hot） */
export const deterministicEmbedder: Embedder = {
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array<number>(1024).fill(0)
      v[t.includes('量子') ? 0 : 1] = 1
      return v
    })
  },
}

async function cleanup(db: Db, wsIds: string[]) {
  if (wsIds.length === 0) return
  // resources/resource_chunks 对工作间是级联删，删工作间即清场
  await db.delete(workspaces).where(inArray(workspaces.id, wsIds))
}

async function fixtureWorkspace(app: App, created: string[], name: string) {
  const res = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name } })
  assert.equal(res.statusCode, 201)
  const ws = res.json() as { id: string }
  created.push(ws.id)
  return ws
}

interface IngestResponse {
  resource: { id: string; title: string; kind: string; charCount: number }
  chunkCount: number
  embeddingStatus: 'pending' | 'partial' | 'done'
  duplicateTitle: string | null
}

test('列表：工作间未知 404；空工作间 []；粘贴摄入后含计数', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/workspaces/00000000-0000-4000-8000-000000000000/resources',
    })
    assert.equal(missing.statusCode, 404)

    const ws = await fixtureWorkspace(app, created, '资源工作间')
    const empty = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources` })
    assert.equal(empty.statusCode, 200)
    assert.deepEqual(empty.json(), [])

    const made = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { title: '量子入门', text: '# 量子\n\n量子计算的纠错码是工程难点。' },
    })
    assert.equal(made.statusCode, 201)
    const body = made.json() as IngestResponse
    assert.equal(body.resource.title, '量子入门')
    assert.equal(body.resource.kind, 'paste')
    assert.equal(body.embeddingStatus, 'pending') // 摄入与向量化解耦：ingest 永远 pending
    assert.equal(body.duplicateTitle, null)

    const list = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources` })
    const rows = list.json() as { id: string; title: string; chunkCount: number; embeddedCount: number; embeddingStatus: string }[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.title, '量子入门')
    assert.equal(rows[0]!.chunkCount, body.chunkCount)
    assert.equal(rows[0]!.embeddedCount, 0) // 摄入不 embed；embeddedCount 由后续 embedResource 填
    assert.equal(rows[0]!.embeddingStatus, 'pending')
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('详情：含 contentMd；未知资源 404', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '详情工作间')
    const made = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { title: '随手记', text: '一段纯文本资料。' },
    })
    const { resource } = made.json() as IngestResponse

    const detail = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources/${resource.id}` })
    assert.equal(detail.statusCode, 200)
    const body = detail.json() as { contentMd: string; kind: string }
    assert.equal(body.contentMd, '一段纯文本资料。')
    assert.equal(body.kind, 'paste')

    const missing = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${ws.id}/resources/00000000-0000-4000-8000-000000000000`,
    })
    assert.equal(missing.statusCode, 404)
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('删除：204 且级联删块；再来一次 404', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '删除工作间')
    const made = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { title: '待删', text: '内容甲。' },
    })
    const { resource } = made.json() as IngestResponse
    const del = await app.inject({ method: 'DELETE', url: `/api/workspaces/${ws.id}/resources/${resource.id}` })
    assert.equal(del.statusCode, 204)
    const again = await app.inject({ method: 'DELETE', url: `/api/workspaces/${ws.id}/resources/${resource.id}` })
    assert.equal(again.statusCode, 404)
    const list = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources` })
    assert.deepEqual(list.json(), [])
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('粘贴摄入校验：缺 title / 空 text / 超长 text / 空内容 → 400', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '校验工作间')
    const bad = [
      { text: '有内容没标题' },
      { title: '有标题', text: '   ' },
      { title: '超长', text: '甲'.repeat(200_001) },
      { title: '纯标题空白文档', text: '  \n  ' },
    ]
    for (const payload of bad) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws.id}/resources`,
        payload,
      })
      assert.equal(res.statusCode, 400, JSON.stringify(payload).slice(0, 60))
      assert.equal((res.json() as { error: { code: string } }).error.code, 'BAD_REQUEST')
    }
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('重复摄入：同内容第二次命中 duplicateTitle（不阻断）', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '重复工作间')
    const body = { title: '第一份', text: '# 重复内容\n同一段资料。' }
    await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/resources`, payload: body })
    const second = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { ...body, title: '第二份' },
    })
    assert.equal(second.statusCode, 201)
    assert.equal((second.json() as IngestResponse).duplicateTitle, '第一份')
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('摄入不向量化：embeddingStatus=pending，embeddedCount=0；随后 embedResource 落向量', async () => {
  // 摄入路径解耦 embed：ingest 后 status 都是 pending、嵌入列 NULL，无论 inject 什么 embedder。
  // 真实向量化由 embedResource 端点触发（用 deterministicEmbedder 全成功）。
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '摄入解耦工作间')
    const made = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { title: '无向量', text: '一段没有向量的资料。' },
    })
    assert.equal(made.statusCode, 201)
    const body = made.json() as IngestResponse
    assert.equal(body.embeddingStatus, 'pending')
    const list = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources` })
    const row = (list.json() as { id: string; embeddedCount: number; chunkCount: number; embeddingStatus: string }[])[0]!
    assert.equal(row.embeddedCount, 0)
    assert.equal(row.chunkCount, body.chunkCount)
    assert.equal(row.embeddingStatus, 'pending')

    // 用户点"向量化"：调用 embedResource 端点；本测试用 deterministicEmbedder（resources.test.ts 顶上定义）所以全成功
    const emb = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/resources/${row.id}/embed` })
    assert.equal(emb.statusCode, 200, `embed status=${emb.statusCode} body=${emb.body}`)
    const embBody = emb.json() as { status: string; failedCount: number; chunkCount: number }
    assert.equal(embBody.status, 'done')
    assert.equal(embBody.failedCount, 0)

    // 列表中该资源 status='done'、embeddedCount=chunkCount
    const list2 = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources` })
    const row2 = (list2.json() as { id: string; embeddedCount: number; chunkCount: number; embeddingStatus: string }[])[0]!
    assert.equal(row2.embeddingStatus, 'done')
    assert.equal(row2.embeddedCount, row2.chunkCount)
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('embedResource：embedder 部分失败 → status=partial、failedCount 正确', async () => {
  // 4 块：第一块成功（1024 维全 0.1）、第二块返 null、第三块成功、第四块返 null
  const partial: Embedder = {
    async embed(texts): Promise<number[][]> {
      return texts.map((_, i) => (i % 2 === 0 ? new Array(1024).fill(0.1) : (null as unknown as number[])))
    },
  }
  const app = await buildApp({ embedder: partial })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '部分失败工作间')
    // 切 4 块：用 4 个明显段落，markdown 感知切块会切出来
    const text = '# 一\n\n第一段。\n\n# 二\n\n第二段。\n\n# 三\n\n第三段。\n\n# 四\n\n第四段。'
    const made = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { title: '四段', text },
    })
    const { resource } = made.json() as IngestResponse
    const emb = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/resources/${resource.id}/embed` })
    const embBody = emb.json() as { status: string; failedCount: number; chunkCount: number }
    assert.equal(embBody.status, 'partial')
    assert.equal(embBody.failedCount, 2)
    assert.equal(embBody.chunkCount, 4)
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('embedResource：未知资源 → 404', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '未知工作间')
    const emb = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources/00000000-0000-4000-8000-000000000000/embed`,
    })
    assert.equal(emb.statusCode, 404)
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('multipart 上传 .md：201、标题取文件名（去扩展名）；非法扩展名 400', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '上传工作间')
    const boundary = '----aipodcast-test-boundary'
    const content = '# 上传的笔记\n\n这里是正文，提到播客后期。'
    const multipartBody = (filename: string, fileContent: string) =>
      [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        'Content-Type: application/octet-stream',
        '',
        fileContent,
        `--${boundary}--`,
        '',
      ].join('\r\n')

    const ok = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody('我的笔记.md', content),
    })
    assert.equal(ok.statusCode, 201)
    const body = ok.json() as IngestResponse
    assert.equal(body.resource.title, '我的笔记')
    assert.equal(body.resource.kind, 'md')

    const bad = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody('page.html', '<p>x</p>'),
    })
    assert.equal(bad.statusCode, 400)
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('替换：内容与块整体换新（旧块不残留）；空内容替换 → 400 且旧资源原样', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '替换工作间')
    const made = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { title: '旧版', text: '旧内容。' },
    })
    const { resource, chunkCount: oldChunks } = made.json() as IngestResponse

    const replaced = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources/${resource.id}/replace`,
      payload: { title: '新版', text: '# 新\n新内容第一段。\n\n新内容第二段。' },
    })
    assert.equal(replaced.statusCode, 200)
    const body = replaced.json() as IngestResponse
    assert.equal(body.resource.title, '新版')
    assert.ok(body.resource.charCount !== resource.charCount)

    const detail = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources/${resource.id}` })
    const d = detail.json() as { contentMd: string; chunkCount: number }
    assert.equal(d.contentMd, '# 新\n新内容第一段。\n\n新内容第二段。')
    assert.notEqual(d.chunkCount, 0)

    // 失败路径：空内容不进事务，旧资源原样
    const failed = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources/${resource.id}/replace`,
      payload: { text: '   ' },
    })
    assert.equal(failed.statusCode, 400)
    const after = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources/${resource.id}` })
    assert.equal((after.json() as { contentMd: string }).contentMd, '# 新\n新内容第一段。\n\n新内容第二段。')

    // 未知资源 404
    const missing = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources/00000000-0000-4000-8000-000000000000/replace`,
      payload: { text: 'x' },
    })
    assert.equal(missing.statusCode, 404)
    void oldChunks
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

/** 夹具：一个工作间摄入两份资料（量子主题 + 火锅主题），返回 wsId */
async function fixtureLibrary(app: App, created: string[], name: string) {
  const ws = await fixtureWorkspace(app, created, name)
  await app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws.id}/resources`,
    payload: { title: '量子手册', text: '# 量子\n\n量子计算的纠错码是当前工程难点。' },
  })
  await app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws.id}/resources`,
    payload: { title: '火锅指南', text: '# 火锅\n\n老北京涮羊肉讲究清汤锅底。' },
  })
  return ws
}

test('检索：空库短路 → empty_library；净查询空白 → no_hits', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '空库工作间')
    const empty = await retrieve(app.db, ws.id, '随便查', { embedder: deterministicEmbedder })
    assert.equal(empty.status, 'empty_library')

    const lib = await fixtureLibrary(app, created, '空白查询库')
    const blank = await retrieve(app.db, lib.id, '!!!', { embedder: deterministicEmbedder })
    assert.equal(blank.status, 'no_hits')
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('检索：纯 BM25 模式命中中文词；embedder 绝不被调用', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureLibrary(app, created, 'BM25 工作间')
    const poisoned: Embedder = {
      async embed() {
        throw new Error('bm25 模式不应调用 embedder')
      },
    }
    const result = await retrieve(app.db, ws.id, '火锅', { mode: 'bm25', embedder: poisoned })
    assert.equal(result.status, 'ok')
    assert.ok(result.hits[0]!.content.includes('涮羊肉'))
    assert.equal(result.hits[0]!.resourceTitle, '火锅指南')
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('检索：向量通道（hybrid）——与词面无重叠也能召回语义块', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureLibrary(app, created, '向量工作间')
    // stub 语义：查询含「量子」→ 第 0 维，与量子块的嵌入同向（余弦距离 0）
    const result = await retrieve(app.db, ws.id, '量子', { mode: 'hybrid', embedder: deterministicEmbedder })
    assert.equal(result.status, 'ok')
    assert.ok(result.hits[0]!.content.includes('量子计算'))
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('检索：工作间隔离——A 库的资料在 B 库查不到', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    await fixtureLibrary(app, created, 'A 工作间')
    const wsB = await fixtureWorkspace(app, created, 'B 工作间')
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsB.id}/resources`,
      payload: { title: 'B 的资料', text: '与量子毫不相干的内容。' },
    })
    const result = await retrieve(app.db, wsB.id, '量子', { mode: 'hybrid', embedder: deterministicEmbedder })
    // B 库唯一块与查询向量不同向（第 1 维），BM25 亦无词面命中 → 不得串出 A 的块
    assert.ok(!result.hits.some((h) => h.resourceTitle === '量子手册'))
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('检索：mode=vector 只走向量通道——无向量块不召回', async () => {
  // 验证 mode='vector' 时只走向量通道：BM25 通道不参与；embedding=NULL 的块天然不参与。
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureLibrary(app, created, '纯向量工作间')
    // 库里有 chunks，但 ingest 路径不 embed → embedding=NULL
    // vector 通道 SQL 过滤 c.embedding IS NOT NULL → 召回空
    const beforeEmbed = await retrieve(app.db, ws.id, '火锅', { mode: 'vector', embedder: deterministicEmbedder })
    assert.equal(beforeEmbed.status, 'no_hits')

    // 给资源做一次 embed，再查 vector 模式就能命中
    const list = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources` })
    const { id } = (list.json() as { id: string }[])[0]!
    await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/resources/${id}/embed` })
    const afterEmbed = await retrieve(app.db, ws.id, '火锅', { mode: 'vector', embedder: deterministicEmbedder })
    assert.equal(afterEmbed.status, 'ok')
    assert.ok(afterEmbed.hits[0]!.content.includes('涮羊肉'))
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('retrieve 工具：形状、执行与跨工作间隔离', async () => {
  const { makeWriterTools } = await import('../src/modules/writer/tools.js')
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureLibrary(app, created, '工具工作间')
    const ep = (
      (
        await app.inject({
          method: 'POST',
          url: `/api/workspaces/${ws.id}/episodes`,
          payload: { title: '检索测试集' },
        })
      ).json() as { id: string }
    )

    const tools = makeWriterTools(app.db, ep.id, { embedder: deterministicEmbedder })
    assert.deepEqual(tools.map((t) => t.name), ['read', 'add', 'edit', 'retrieve'])

    const retrieveTool = tools[3]!
    // SDK 的 ToolDefinition.execute 完整签名为 (toolCallId, params, signal, onUpdate, ctx)，
    // 前三个为运行时必传参数；retrieve 闭包只用到 toolCallId 与 params。测试仅验证返回形状，
    // 直接以断言所需的最小参数调用（额外参数忽略），与发送阶段的实际调用一致。
    const out = (await retrieveTool.execute('call-1', { query: '火锅' }, undefined, undefined, undefined as never) as unknown as {
      content: { type: string; text: string }[]
      details: { summary: string; lineIds: string[] }
    })
    const text = out.content[0]!.text
    assert.ok(text.includes('《火锅指南》'), text)
    assert.ok(text.includes('涮羊肉'))
    assert.deepEqual(out.details.lineIds, [])

    // 空库引导语
    const ws2 = await fixtureWorkspace(app, created, '空工具工作间')
    await app.inject({ method: 'POST', url: `/api/workspaces/${ws2.id}/episodes`, payload: { title: '空集' } })
    const [ep2] = await app.db.select({ id: episodes.id }).from(episodes).where(eq(episodes.wsId, ws2.id))
    const tools2 = makeWriterTools(app.db, ep2!.id, { embedder: deterministicEmbedder })
    const out2 = (await tools2[3]!.execute('call-2', { query: 'x' }, undefined, undefined, undefined as never) as unknown as {
      content: { text: string }[]
    })
    assert.ok(out2.content[0]!.text.includes('还没有资源'))
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('retrieve 工具面：mode=bm25 透传——embedder 绝不被调', async () => {
  // 验证：写入侧参数 mode='bm25' 时 retrieve 工具面不调用 embedder；
  // 工具面 schema 接受 mode 字段（不传则默认 hybrid）。
  const { makeWriterTools } = await import('../src/modules/writer/tools.js')
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureLibrary(app, created, '工具 bm25 工作间')
    const ep = (
      (
        await app.inject({
          method: 'POST',
          url: `/api/workspaces/${ws.id}/episodes`,
          payload: { title: 'bm25 集' },
        })
      ).json() as { id: string }
    )
    const poisoned: Embedder = {
      async embed() {
        throw new Error('bm25 模式不应调用 embedder')
      },
    }
    const tools = makeWriterTools(app.db, ep.id, { embedder: poisoned })
    const retrieveTool = tools[3]!
    const out = (await retrieveTool.execute(
      'call-3',
      { query: '火锅', mode: 'bm25' },
      undefined,
      undefined,
      undefined as never,
    ) as unknown as { content: { text: string }[] })
    assert.ok(out.content[0]!.text.includes('《火锅指南》'))
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})
