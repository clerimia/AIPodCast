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

test('embedding 全失败 → 201 + embedWarning + 向量覆盖 0（检索仍可走全文）', async () => {
  const failing: Embedder = { async embed() { return null } }
  const app = await buildApp({ embedder: failing })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '降级工作间')
    const made = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { title: '无向量', text: '一段没有向量的资料。' },
    })
    assert.equal(made.statusCode, 201)
    const body = made.json() as IngestResponse
    assert.ok(body.embedWarning)
    assert.ok(body.embedWarning!.includes('未生成向量'))
    const list = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources` })
    const row = (list.json() as { embeddedCount: number; chunkCount: number }[])[0]!
    assert.equal(row.embeddedCount, 0)
    assert.equal(row.chunkCount, body.chunkCount)
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
