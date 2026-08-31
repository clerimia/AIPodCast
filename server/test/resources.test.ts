import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inArray } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { workspaces } from '../src/db/schema.js'
import type { Embedder } from '../src/modules/resources/embed.js'

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
  embedWarning: string | null
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
    assert.equal(body.embedWarning, null)
    assert.equal(body.duplicateTitle, null)

    const list = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources` })
    const rows = list.json() as { id: string; title: string; chunkCount: number; embeddedCount: number }[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.title, '量子入门')
    assert.equal(rows[0]!.chunkCount, body.chunkCount)
    assert.equal(rows[0]!.embeddedCount, body.chunkCount) // stub 全成功 → 向量全覆盖
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
