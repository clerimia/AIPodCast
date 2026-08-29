import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import {
  audioAssets,
  changeSetOps,
  changeSets,
  episodes,
  postRules,
  scriptLines,
  workspaces,
} from '../src/db/schema.js'

// M2 script 模块集成测试（docs/api-and-dataflow.md「单集与脚本」+「后期参数」表）：
// 真 DB（compose Postgres）+ app.inject。每例自建工作间夹具并在收尾清场——
// script_lines.speaker_id 外键无级联动作，先清行再删工作间。
type App = Awaited<ReturnType<typeof buildApp>>

interface Fixture {
  app: App
  wsId: string
  speakerId: string
  speaker2Id: string
  episodeId: string
  created: string[]
}

async function fixture(app: App, title = '脚本夹具集'): Promise<Fixture> {
  const created: string[] = []
  const ws = (
    (await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: '脚本工作间' } })).json() as {
      id: string
    }
  )
  created.push(ws.id)
  const speaker = (
    (
      await app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws.id}/speakers`,
        payload: { name: '主持人', voice: 'Cherry' },
      })
    ).json() as { id: string }
  )
  const speaker2 = (
    (
      await app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws.id}/speakers`,
        payload: { name: '嘉宾', voice: 'Ethan' },
      })
    ).json() as { id: string }
  )
  const ep = (
    (
      await app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws.id}/episodes`,
        payload: { title },
      })
    ).json() as { id: string }
  )
  return { app, wsId: ws.id, speakerId: speaker.id, speaker2Id: speaker2.id, episodeId: ep.id, created }
}

async function cleanup(app: App, wsIds: string[]) {
  if (wsIds.length === 0) return
  await app.db
    .delete(scriptLines)
    .where(
      inArray(
        scriptLines.episodeId,
        app.db.select({ id: episodes.id }).from(episodes).where(inArray(episodes.wsId, wsIds)),
      ),
    )
  await app.db.delete(workspaces).where(inArray(workspaces.id, wsIds))
}

/** 建一行脚本的音频素材（作废验证用；文件本体在 MEDIA_ROOT，DB 测试不需要） */
async function fixtureAsset(app: App, scriptLineId: string) {
  await app.db.insert(audioAssets).values({ scriptLineId, audioRef: `t/${scriptLineId}.wav`, durationMs: 1234 })
}

async function getScript(app: App, episodeId: string) {
  const res = await app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/script` })
  assert.equal(res.statusCode, 200)
  return res.json() as {
    lines: {
      id: string
      serial: string
      speakerId: string
      speakerName: string
      text: string
      instructions: string
      post: Record<string, unknown>
      asset: { has: boolean; durationMs: number | null }
    }[]
  }
}

function addOp(afterLineId: string | null, text: string, speakerId: string, instructions = '') {
  return { op: 'add', afterLineId, speakerId, text, instructions }
}

test('空集 GET script → { lines: [] }；未知/非法 episodeId → 404', async () => {
  const app = await buildApp()
  const f = await fixture(app, '空集')
  try {
    const script = await getScript(app, f.episodeId)
    assert.deepEqual(script, { lines: [] })

    const missing = '00000000-0000-4000-8000-00000000000f'
    for (const url of [`/api/episodes/${missing}`, `/api/episodes/${missing}/script`]) {
      const res = await app.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 404, url)
      assert.equal((res.json() as { error: { code: string } }).error.code, 'NOT_FOUND')
    }
    const bad = await app.inject({ method: 'GET', url: '/api/episodes/not-a-uuid/script' })
    assert.equal(bad.statusCode, 404)
  } finally {
    await cleanup(app, f.created)
    await app.close()
  }
})

test('单集详情：title / show_notes / post_rules 默认（中/正常）/ artifact null', async () => {
  const app = await buildApp()
  const f = await fixture(app, '详情集')
  try {
    const res = await app.inject({ method: 'GET', url: `/api/episodes/${f.episodeId}` })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      id: f.episodeId,
      wsId: f.wsId,
      title: '详情集',
      showNotes: '',
      postRules: { pause: '中', speed: '正常' },
      artifact: null,
    })
  } finally {
    await cleanup(app, f.created)
    await app.close()
  }
})

test('手动加行：null 插最前、afterLineId 插中间 → serial 重编 L001…，刷新持久，ChangeSet 落库', async () => {
  const app = await buildApp()
  const f = await fixture(app)
  try {
    const first = await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: { ops: [addOp(null, '开场白', f.speakerId)], summary: '开头一行' },
    })
    assert.equal(first.statusCode, 200)
    const firstBody = first.json() as {
      changeSetId: string
      invalidatedLineIds: string[]
      summary: string | null
      lines: { id: string; serial: string; text: string; instructions: string; speakerName: string; post: unknown; asset: unknown }[]
    }
    const anchor = firstBody.lines[0]!.id
    assert.equal(firstBody.summary, '开头一行')
    assert.match(firstBody.changeSetId, /^[0-9a-f-]{36}$/)
    assert.deepEqual(firstBody.invalidatedLineIds, [])
    assert.deepEqual(firstBody.lines.map((l) => [l.serial, l.text, l.instructions]), [
      ['L001', '开场白', ''],
    ])
    assert.equal(firstBody.lines[0]!.speakerName, '主持人')
    assert.deepEqual(firstBody.lines[0]!.post, {})
    assert.deepEqual(firstBody.lines[0]!.asset, { has: false, durationMs: null })

    // 锚点行后插一行 + null 再置顶一行：null = 插到最前（后提交的 null 行排前）
    const second = await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: {
        ops: [addOp(anchor, '插播', f.speakerId, '沉稳地说'), addOp(null, '置顶', f.speakerId)],
      },
    })
    assert.equal(second.statusCode, 200)
    assert.deepEqual(
      (second.json() as { lines: { serial: string; text: string }[] }).lines.map((l) => [l.serial, l.text]),
      [
        ['L001', '置顶'],
        ['L002', '开场白'],
        ['L003', '插播'],
      ],
    )

    // 刷新持久
    const refreshed = await getScript(app, f.episodeId)
    assert.deepEqual(
      refreshed.lines.map((l) => [l.serial, l.text]),
      [
        ['L001', '置顶'],
        ['L002', '开场白'],
        ['L003', '插播'],
      ],
    )

    // ChangeSet 记账：两提交两条；base_version 顺序计数；ops payload 形状
    const sets = await app.db.select().from(changeSets).where(eq(changeSets.episodeId, f.episodeId))
    assert.equal(sets.length, 2)
    assert.deepEqual(
      sets.map((s) => s.baseVersion).sort((a, b) => a - b),
      [0, 1],
    )
    assert.ok(sets.every((s) => s.kind === 'user'))
    const secondCsId = (second.json() as { changeSetId: string }).changeSetId
    const ops = await app.db.select().from(changeSetOps).where(eq(changeSetOps.csId, secondCsId))
    assert.deepEqual(
      ops.map((o) => [o.seq, o.op]),
      [
        [1, 'add'],
        [2, 'add'],
      ],
    )
    assert.equal(ops[0]!.payload && (ops[0]!.payload as { afterLineId: string }).afterLineId, anchor)
    assert.equal(ops[0]!.lineId, (second.json() as { lines: { id: string }[] }).lines[2]!.id)
  } finally {
    await cleanup(app, f.created)
    await app.close()
  }
})

test('改台词/指令/换说话人 → invalidatedLineIds 覆盖、素材作废；同值/空 patch 不作废', async () => {
  const app = await buildApp()
  const f = await fixture(app)
  try {
    // 倒序发 null（=逐个置顶），得到确定顺序 甲/乙/丙
    const made = await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: {
        ops: [
          addOp(null, '丙', f.speaker2Id),
          addOp(null, '乙', f.speakerId),
          addOp(null, '甲', f.speakerId),
        ],
      },
    })
    const lines = (made.json() as { lines: { id: string }[] }).lines
    const [a, b, c] = [lines[0]!.id, lines[1]!.id, lines[2]!.id]

    await fixtureAsset(app, a)

    const edited = await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: {
        ops: [
          { op: 'edit', lineId: a, patch: { text: '甲改' } },
          { op: 'edit', lineId: b, patch: { instructions: '兴奋' } },
          { op: 'edit', lineId: c, patch: { speakerId: f.speakerId } },
          { op: 'edit', lineId: b, patch: {} },
          { op: 'edit', lineId: b, patch: { instructions: '兴奋' } },
        ],
      },
    })
    assert.equal(edited.statusCode, 200)
    const result = edited.json() as { invalidatedLineIds: string[] }
    assert.deepEqual(result.invalidatedLineIds.sort(), [a, b, c].sort())

    // 素材行已删；GET script 该行 asset.has=false
    const assetRows = await app.db.select().from(audioAssets).where(eq(audioAssets.scriptLineId, a))
    assert.equal(assetRows.length, 0)
    const script = await getScript(app, f.episodeId)
    assert.deepEqual(script.lines.find((l) => l.id === a)!.asset, { has: false, durationMs: null })
    assert.equal(script.lines.find((l) => l.id === c)!.speakerName, '主持人')
  } finally {
    await cleanup(app, f.created)
    await app.close()
  }
})

test('删行 → 逻辑删除出投影、serial 压实重编、素材作废；重排 → serial 跟随且不作废素材', async () => {
  const app = await buildApp()
  const f = await fixture(app)
  try {
    // 倒序发 null（=逐个置顶），得到确定顺序 一/二/三
    const made = await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: {
        ops: [addOp(null, '三', f.speakerId), addOp(null, '二', f.speakerId), addOp(null, '一', f.speakerId)],
      },
    })
    const lines = (made.json() as { lines: { id: string }[] }).lines
    const [id1, id2, id3] = [lines[0]!.id, lines[1]!.id, lines[2]!.id]
    await fixtureAsset(app, id2)

    const removed = await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: { ops: [{ op: 'delete', lineId: id1 }] },
    })
    assert.equal(removed.statusCode, 200)
    assert.deepEqual((removed.json() as { invalidatedLineIds: string[] }).invalidatedLineIds, [id1])
    let script = await getScript(app, f.episodeId)
    assert.deepEqual(script.lines.map((l) => [l.serial, l.id]), [
      ['L001', id2],
      ['L002', id3],
    ])
    assert.equal((await app.db.select().from(audioAssets).where(eq(audioAssets.scriptLineId, id1))).length, 0)
    // 逻辑删除行仍在库里（id 永不复用）
    const soft = await app.db.select().from(scriptLines).where(eq(scriptLines.id, id1))
    assert.equal(soft[0]!.deleted, true)

    // 纯重排：serial 跟随新序，素材不动、invalidated 为空
    const reordered = await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: { ops: [{ op: 'reorder', lineIds: [id3, id2] }] },
    })
    assert.equal(reordered.statusCode, 200)
    assert.deepEqual((reordered.json() as { invalidatedLineIds: string[] }).invalidatedLineIds, [])
    script = await getScript(app, f.episodeId)
    assert.deepEqual(script.lines.map((l) => [l.serial, l.id]), [
      ['L001', id3],
      ['L002', id2],
    ])
    assert.equal((await app.db.select().from(audioAssets).where(eq(audioAssets.scriptLineId, id2))).length, 1)

    // 同提交内先 edit 后 delete：合法（edit 被跳过——行随即逻辑删除，永不可见）
    const skipEdit = await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: {
        ops: [
          { op: 'edit', lineId: id3, patch: { text: '改了又删' } },
          { op: 'delete', lineId: id3 },
        ],
      },
    })
    assert.equal(skipEdit.statusCode, 200)
    assert.deepEqual(
      (skipEdit.json() as { invalidatedLineIds: string[] }).invalidatedLineIds,
      [id3],
    )
    script = await getScript(app, f.episodeId)
    assert.deepEqual(script.lines.map((l) => l.id), [id2])
  } finally {
    await cleanup(app, f.created)
    await app.close()
  }
})

test('冲突与形状校验：引用失效 409、reorder 非排列/坏形状/空 ops 400、未知说话人 404', async () => {
  const app = await buildApp()
  const f = await fixture(app)
  try {
    const made = await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: { ops: [addOp(null, '一行', f.speakerId)] },
    })
    const lineId = (made.json() as { lines: { id: string }[] }).lines[0]!.id
    const ghost = '00000000-0000-4000-8000-0000000000aa'
    const changes = (ops: unknown[]) => ({
      method: 'POST' as const,
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: { ops },
    })

    // 409：edit/delete 未知行、add 锚点未知、同提交内先删后改
    for (const ops of [
      [{ op: 'edit', lineId: ghost, patch: { text: 'x' } }],
      [{ op: 'delete', lineId: ghost }],
      [addOp(ghost, 'x', f.speakerId)],
      [{ op: 'delete', lineId: lineId }, { op: 'edit', lineId, patch: { text: 'x' } }],
    ]) {
      const res = await app.inject(changes(ops))
      assert.equal(res.statusCode, 409, JSON.stringify(ops))
      assert.equal((res.json() as { error: { code: string } }).error.code, 'CONFLICT')
    }

    // 400：reorder 非排列、未知 op、缺 text、空 ops、坏 afterLineId
    for (const ops of [
      [{ op: 'reorder', lineIds: [lineId, ghost] }],
      [{ op: 'reorder', lineIds: [] }],
      [{ op: 'noop' }],
      [{ op: 'add', afterLineId: null, speakerId: f.speakerId, text: '' }],
      [{ op: 'add', afterLineId: 'not-a-uuid', speakerId: f.speakerId, text: 'x' }],
    ]) {
      const res = await app.inject(changes(ops))
      assert.equal(res.statusCode, 400, JSON.stringify(ops))
      assert.equal((res.json() as { error: { code: string } }).error.code, 'BAD_REQUEST')
    }
    const empty = await app.inject(changes([]))
    assert.equal(empty.statusCode, 400)

    // 404：未知说话人（不存在 vs 不属于本工作间同样报 NOT_FOUND）
    const stranger = await app.inject(
      changes([addOp(null, 'x', '00000000-0000-4000-8000-0000000000bb')]),
    )
    assert.equal(stranger.statusCode, 404)

    // 失败提交不留账：ChangeSet 仍只有一条（第一次成功提交）
    const sets = await app.db.select().from(changeSets).where(eq(changeSets.episodeId, f.episodeId))
    assert.equal(sets.length, 1)
  } finally {
    await cleanup(app, f.created)
    await app.close()
  }
})

test('客户端预生成 id 的暂存新增行可被同提交的 afterLineId/reorder 引用；重复 id 400', async () => {
  const app = await buildApp()
  const f = await fixture(app)
  try {
    const n1 = '00000000-0000-4000-8000-0000000abc01'
    const n2 = '00000000-0000-4000-8000-0000000abc02'
    const res = await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: {
        ops: [
          { op: 'add', id: n1, afterLineId: null, speakerId: f.speakerId, text: '一' },
          { op: 'add', id: n2, afterLineId: n1, speakerId: f.speakerId, text: '二' },
          { op: 'reorder', lineIds: [n2, n1] },
        ],
      },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(
      (res.json() as { lines: { id: string; serial: string }[] }).lines.map((l) => [l.id, l.serial]),
      [
        [n2, 'L001'],
        [n1, 'L002'],
      ],
    )

    // 重复 add.id → 400（id 与现有行不相撞，纯属同提交内重复）；与现有行相撞 → 409
    const d1 = '00000000-0000-4000-8000-0000000abc03'
    const dup = await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: {
        ops: [
          { op: 'add', id: d1, afterLineId: null, speakerId: f.speakerId, text: '三' },
          { op: 'add', id: d1, afterLineId: null, speakerId: f.speakerId, text: '四' },
        ],
      },
    })
    assert.equal(dup.statusCode, 400)
    const collide = await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: {
        ops: [{ op: 'add', id: n2, afterLineId: null, speakerId: f.speakerId, text: '五' }],
      },
    })
    assert.equal(collide.statusCode, 409)
  } finally {
    await cleanup(app, f.created)
    await app.close()
  }
})

test('集级 post-rules PATCH：更新/部分更新/校验失败；不经确认门（无 ChangeSet）', async () => {
  const app = await buildApp()
  const f = await fixture(app)
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/episodes/${f.episodeId}/post-rules`,
      payload: { pause: '长' },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { pause: '长', speed: '正常' })

    const both = await app.inject({
      method: 'PATCH',
      url: `/api/episodes/${f.episodeId}/post-rules`,
      payload: { pause: '短', speed: '快' },
    })
    assert.deepEqual(both.json(), { pause: '短', speed: '快' })

    for (const payload of [{ pause: '特短' }, { speed: null }, {}]) {
      const bad = await app.inject({
        method: 'PATCH',
        url: `/api/episodes/${f.episodeId}/post-rules`,
        payload,
      })
      assert.equal(bad.statusCode, 400, JSON.stringify(payload))
    }

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/episodes/00000000-0000-4000-8000-0000000000cc/post-rules`,
      payload: { pause: '长' },
    })
    assert.equal(missing.statusCode, 404)

    const sets = await app.db.select().from(changeSets).where(eq(changeSets.episodeId, f.episodeId))
    assert.equal(sets.length, 0)
    const rules = await app.db.select().from(postRules).where(eq(postRules.episodeId, f.episodeId))
    assert.deepEqual(rules[0], { ...rules[0], pause: '短', speed: '快' })
  } finally {
    await cleanup(app, f.created)
    await app.close()
  }
})

test('逐行 post PATCH：设置/清除覆盖；不产生 ChangeSet、不作废素材；未知或已删行 404', async () => {
  const app = await buildApp()
  const f = await fixture(app)
  try {
    const made = await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: { ops: [addOp(null, '一行', f.speakerId), addOp(null, '两行', f.speakerId)] },
    })
    const [id1, id2] = (made.json() as { lines: { id: string }[] }).lines.map((l) => l.id) as [string, string]
    await fixtureAsset(app, id1)
    const post = (lineId: string, payload: Record<string, unknown>) => ({
      method: 'PATCH' as const,
      url: `/api/episodes/${f.episodeId}/lines/${lineId}/post`,
      payload,
    })

    assert.deepEqual(
      (await app.inject(post(id1, { pause: '短' }))).json(),
      { pause: '短' },
    )
    assert.deepEqual(
      (await app.inject(post(id1, { pause: '短', speed: '快' }))).json(),
      { pause: '短', speed: '快' },
    )
    // null 清除单字段，另一字段保留
    assert.deepEqual((await app.inject(post(id1, { pause: null }))).json(), { speed: '快' })
    // 全清后为空对象（回退集级默认）
    assert.deepEqual((await app.inject(post(id1, { speed: null }))).json(), {})

    // GET script 里 post 投影同步；素材未作废
    const script = await getScript(app, f.episodeId)
    assert.deepEqual(script.lines.find((l) => l.id === id1)!.post, {})
    assert.equal((await app.db.select().from(audioAssets).where(eq(audioAssets.scriptLineId, id1))).length, 1)
    const sets = await app.db.select().from(changeSets).where(eq(changeSets.episodeId, f.episodeId))
    assert.equal(sets.length, 1) // 只有开头那次建行提交

    // 非法档位/空体 → 400
    for (const payload of [{ pause: '超长' }, { speed: 2 }, {}]) {
      const bad = await app.inject(post(id1, payload))
      assert.equal(bad.statusCode, 400, JSON.stringify(payload))
    }
    // 未知行 / 已删行 → 404
    assert.equal((await app.inject(post('00000000-0000-4000-8000-0000000000dd', { pause: '短' }))).statusCode, 404)
    await app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: { ops: [{ op: 'delete', lineId: id2 }] },
    })
    assert.equal((await app.inject(post(id2, { pause: '短' }))).statusCode, 404)
  } finally {
    await cleanup(app, f.created)
    await app.close()
  }
})
