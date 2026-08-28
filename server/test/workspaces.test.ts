import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import {
  conversations,
  episodes,
  postRules,
  scriptLines,
  workspaces,
} from '../src/db/schema.js'

// M1 workspaces 模块集成测试（docs/api-and-dataflow.md「工作间与单集」表）：
// 真 DB（compose Postgres）+ app.inject。每例自建工作间并在收尾清场——
// script_lines.speaker_id 外键无级联动作，级联删除顺序不保证，先清行再删工作间。
type Db = Awaited<ReturnType<typeof buildApp>>['db']

async function cleanup(db: Db, wsIds: string[]) {
  if (wsIds.length === 0) return
  await db
    .delete(scriptLines)
    .where(
      inArray(
        scriptLines.episodeId,
        db.select({ id: episodes.id }).from(episodes).where(inArray(episodes.wsId, wsIds)),
      ),
    )
  await db.delete(workspaces).where(inArray(workspaces.id, wsIds))
}

/** 建一个工作间作为夹具，返回 id 并登记清场 */
async function fixtureWorkspace(app: Awaited<ReturnType<typeof buildApp>>, created: string[], name: string) {
  const res = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name } })
  assert.equal(res.statusCode, 201)
  const ws = res.json() as { id: string }
  created.push(ws.id)
  return ws
}

test('建工作间 → 列表可见 → 详情含默认 show_metadata 与空 speakers', async () => {
  const app = await buildApp()
  const created: string[] = []
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: '科技早点' },
    })
    assert.equal(res.statusCode, 201)
    const ws = res.json() as { id: string; name: string; createdAt: string }
    created.push(ws.id)
    assert.equal(ws.name, '科技早点')
    assert.equal(typeof ws.createdAt, 'string')

    const list = await app.inject({ method: 'GET', url: '/api/workspaces' })
    assert.equal(list.statusCode, 200)
    assert.ok((list.json() as { id: string }[]).some((w) => w.id === ws.id))

    const detail = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}` })
    assert.equal(detail.statusCode, 200)
    assert.deepEqual(detail.json(), {
      id: ws.id,
      name: '科技早点',
      showMetadata: { outline: '', topic: '', tone: '', terms: '', bannedWords: '', intro: '' },
      speakers: [],
    })
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('建工作间缺 name / 空 name → 400 BAD_REQUEST', async () => {
  const app = await buildApp()
  try {
    for (const payload of [{}, { name: '' }, { name: '   ' }]) {
      const res = await app.inject({ method: 'POST', url: '/api/workspaces', payload })
      assert.equal(res.statusCode, 400, `payload=${JSON.stringify(payload)}`)
      assert.equal((res.json() as { error: { code: string } }).error.code, 'BAD_REQUEST')
    }
  } finally {
    await app.close()
  }
})

test('未知工作间（详情 / 元数据 / 说话人 / 单集）→ 404 NOT_FOUND', async () => {
  const app = await buildApp()
  try {
    const missing = '00000000-0000-4000-8000-000000000000'
    const urls = [
      `/api/workspaces/${missing}`,
      `/api/workspaces/${missing}/show-metadata`,
      `/api/workspaces/${missing}/speakers`,
      `/api/workspaces/${missing}/episodes`,
    ]
    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 404, url)
      assert.equal((res.json() as { error: { code: string } }).error.code, 'NOT_FOUND')
    }
    // 非法 uuid 同样按资源不存在处理
    const bad = await app.inject({ method: 'GET', url: '/api/workspaces/not-a-uuid' })
    assert.equal(bad.statusCode, 404)
  } finally {
    await app.close()
  }
})

test('PUT show-metadata 更新并持久化；缺省字段不动', async () => {
  const app = await buildApp()
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '元数据工作间')
    const put = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${ws.id}/show-metadata`,
      payload: {
        outline: '每周聊 AI',
        topic: 'AI 工程化',
        tone: '轻松',
        terms: 'RAG、Agent',
        bannedWords: '赋能',
        intro: '一档关于 AI 的播客',
      },
    })
    assert.equal(put.statusCode, 200)
    assert.deepEqual(put.json(), {
      outline: '每周聊 AI',
      topic: 'AI 工程化',
      tone: '轻松',
      terms: 'RAG、Agent',
      bannedWords: '赋能',
      intro: '一档关于 AI 的播客',
    })

    // 刷新后仍读到（持久化）
    const detail = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}` })
    const meta = (detail.json() as { showMetadata: { outline: string; intro: string } }).showMetadata
    assert.equal(meta.outline, '每周聊 AI')
    assert.equal(meta.intro, '一档关于 AI 的播客')

    // 只发部分字段：未提及字段保持不变
    const partial = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${ws.id}/show-metadata`,
      payload: { tone: '严肃' },
    })
    assert.equal(partial.statusCode, 200)
    assert.deepEqual(partial.json(), {
      outline: '每周聊 AI',
      topic: 'AI 工程化',
      tone: '严肃',
      terms: 'RAG、Agent',
      bannedWords: '赋能',
      intro: '一档关于 AI 的播客',
    })
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('建说话人：合法音色 201 并入列表；非法音色 / 缺名 400', async () => {
  const app = await buildApp()
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '说话人工作间')
    const ok = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/speakers`,
      payload: { name: '主持人', persona: '沉稳的好奇者', gender: '男', voice: 'Cherry' },
    })
    assert.equal(ok.statusCode, 201)
    const speaker = ok.json() as { id: string; name: string; persona: string; gender: string; voice: string }
    assert.deepEqual(speaker, {
      id: speaker.id,
      name: '主持人',
      persona: '沉稳的好奇者',
      gender: '男',
      voice: 'Cherry',
    })

    // 详情一次拉全（speakers 随详情返回）
    const detail = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}` })
    assert.deepEqual(
      (detail.json() as { speakers: { id: string }[] }).speakers.map((s) => s.id),
      [speaker.id],
    )

    // 独立列表端点
    const list = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/speakers` })
    assert.equal(list.statusCode, 200)
    assert.equal((list.json() as unknown[]).length, 1)

    // persona/gender 缺省为空串
    const minimal = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/speakers`,
      payload: { name: '嘉宾', voice: 'Ethan' },
    })
    assert.equal(minimal.statusCode, 201)
    assert.deepEqual(minimal.json(), {
      id: (minimal.json() as { id: string }).id,
      name: '嘉宾',
      persona: '',
      gender: '',
      voice: 'Ethan',
    })

    for (const payload of [
      { name: '坏音色', voice: 'NoSuchVoice' },
      { name: '', voice: 'Cherry' },
      { voice: 'Cherry' },
      { name: '缺音色' },
    ]) {
      const bad = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws.id}/speakers`,
        payload,
      })
      assert.equal(bad.statusCode, 400, `payload=${JSON.stringify(payload)}`)
      assert.equal((bad.json() as { error: { code: string } }).error.code, 'BAD_REQUEST')
    }
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('PATCH 说话人：更新字段、其余不动；未知说话人 404', async () => {
  const app = await buildApp()
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '改说话人工作间')
    const made = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/speakers`,
      payload: { name: '主持人', persona: '沉稳', gender: '男', voice: 'Cherry' },
    })
    const speaker = made.json() as { id: string }

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${ws.id}/speakers/${speaker.id}`,
      payload: { persona: '活泼', voice: 'Stella' },
    })
    assert.equal(patched.statusCode, 200)
    assert.deepEqual(patched.json(), {
      id: speaker.id,
      name: '主持人',
      persona: '活泼',
      gender: '男',
      voice: 'Stella',
    })

    const badVoice = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${ws.id}/speakers/${speaker.id}`,
      payload: { voice: 'Nope' },
    })
    assert.equal(badVoice.statusCode, 400)

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${ws.id}/speakers/00000000-0000-4000-8000-000000000001`,
      payload: { name: '谁' },
    })
    assert.equal(missing.statusCode, 404)
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('DELETE 说话人：被 script_lines 引用 → 409 CONFLICT 且不删；改绑后 204', async () => {
  const app = await buildApp()
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '删说话人工作间')
    const speaker = (
      (
        await app.inject({
          method: 'POST',
          url: `/api/workspaces/${ws.id}/speakers`,
          payload: { name: '主持人', voice: 'Cherry' },
        })
      ).json() as { id: string }
    )
    const episode = (
      (
        await app.inject({
          method: 'POST',
          url: `/api/workspaces/${ws.id}/episodes`,
          payload: { title: '引用测试集' },
        })
      ).json() as { id: string }
    )

    // 直接落一行脚本引用该说话人（M2 前无脚本端点，走 DB 夹具）
    await app.db
      .insert(scriptLines)
      .values({ episodeId: episode.id, serial: 'L001', speakerId: speaker.id, text: '你好' })

    const conflict = await app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${ws.id}/speakers/${speaker.id}`,
    })
    assert.equal(conflict.statusCode, 409)
    assert.equal((conflict.json() as { error: { code: string } }).error.code, 'CONFLICT')
    // 冲突后说话人仍在
    const stillThere = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/speakers` })
    assert.equal((stillThere.json() as { id: string }[]).length, 1)

    // 改绑（清掉引用行）后可删
    await app.db.delete(scriptLines).where(eq(scriptLines.episodeId, episode.id))
    const ok = await app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${ws.id}/speakers/${speaker.id}`,
    })
    assert.equal(ok.statusCode, 204)
    const after = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/speakers` })
    assert.equal((after.json() as unknown[]).length, 0)
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('建单集 → 201，连带 conversations(kind=writer) 与 post_rules 默认行（中/正常）', async () => {
  const app = await buildApp()
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '单集工作间')
    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/episodes`,
      payload: { title: 'EP1 上线第一天' },
    })
    assert.equal(res.statusCode, 201)
    const ep = res.json() as { id: string; wsId: string; title: string; showNotes: string; createdAt: string }
    assert.equal(ep.wsId, ws.id)
    assert.equal(ep.title, 'EP1 上线第一天')
    assert.equal(ep.showNotes, '')
    assert.equal(typeof ep.createdAt, 'string')

    const convs = await app.db.select().from(conversations).where(eq(conversations.episodeId, ep.id))
    assert.equal(convs.length, 1)
    assert.equal(convs[0]!.kind, 'writer')

    const rules = await app.db.select().from(postRules).where(eq(postRules.episodeId, ep.id))
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.pause, '中')
    assert.equal(rules[0]!.speed, '正常')

    const list = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/episodes` })
    assert.equal(list.statusCode, 200)
    assert.ok((list.json() as { id: string }[]).some((e) => e.id === ep.id))

    // 缺 title → 400
    const bad = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/episodes`,
      payload: { title: '' },
    })
    assert.equal(bad.statusCode, 400)
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})
