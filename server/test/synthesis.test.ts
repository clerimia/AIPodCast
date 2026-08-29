import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { audioAssets, episodes, scriptLines, workspaces } from '../src/db/schema.js'
import type { TtsClient, TtsInput } from '../src/modules/synthesis/tts.js'
import { makeWav } from './helpers.js'

// M4 synthesis 模块集成测试（docs/api-and-dataflow.md「试听 / 整集合成 / 产物」表）：
// 真 DB + app.inject + 注入 stub TTS（真 DashScope 调用见 scripts/spike-tts.ts）+
// 隔离 MEDIA_ROOT（临时目录）。覆盖：命中/回填、force、作废重合成、错误语义、媒体 Range。

type App = Awaited<ReturnType<typeof buildApp>>

function stubTts(wavFor?: (input: TtsInput, nth: number) => Buffer): { tts: TtsClient; calls: TtsInput[] } {
  const calls: TtsInput[] = []
  return {
    calls,
    tts: {
      async synthesize(input) {
        calls.push(input)
        return (wavFor ?? (() => makeWav({ dataBytes: 48000 })))(input, calls.length - 1)
      },
    },
  }
}

interface Fixture {
  app: App
  wsId: string
  speakerId: string
  episodeId: string
  lineId: string
  mediaRoot: string
  calls: TtsInput[]
}

async function fixture(title: string): Promise<Fixture> {
  const mediaRoot = await mkdtemp(join(tmpdir(), 'aipodcast-media-'))
  const stub = stubTts()
  const app = await buildApp({ mediaRoot, tts: stub.tts })
  const ws = (
    (await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: '合成工作间' } })).json() as {
      id: string
    }
  )
  const speaker = (
    (
      await app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws.id}/speakers`,
        payload: { name: '主持人', voice: 'Cherry' },
      })
    ).json() as { id: string }
  )
  const ep = (
    (
      await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/episodes`, payload: { title } })
    ).json() as { id: string }
  )
  const line = (
    (
      await app.inject({
        method: 'POST',
        url: `/api/episodes/${ep.id}/changes`,
        payload: {
          ops: [{ op: 'add', afterLineId: null, speakerId: speaker.id, text: '欢迎收听本期节目', instructions: '热情一点' }],
        },
      })
    ).json() as { lines: { id: string }[] }
  )
  return {
    app,
    wsId: ws.id,
    speakerId: speaker.id,
    episodeId: ep.id,
    lineId: line.lines[0]!.id,
    mediaRoot,
    calls: stub.calls,
  }
}

async function teardown(app: App, mediaRoot: string, wsId: string) {
  // script_lines.speaker_id 外键无级联动作，先清行再删工作间（与 script.test.ts 一致）
  await app.db
    .delete(scriptLines)
    .where(
      inArray(
        scriptLines.episodeId,
        app.db.select({ id: episodes.id }).from(episodes).where(eq(episodes.wsId, wsId)),
      ),
    )
  await app.db.delete(workspaces).where(eq(workspaces.id, wsId))
  await app.close()
  await rm(mediaRoot, { recursive: true, force: true })
}

interface AssetPayload {
  asset: { id: string; url: string; durationMs: number | null }
}

async function preview(app: App, episodeId: string, lineId: string, body?: { force: boolean }) {
  const res = await app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/lines/${lineId}/preview`, payload: body })
  return { res, body: res.json() as AssetPayload & { error?: { code: string; message: string } } }
}

test('preview 未命中：TTS 合成 → 原子落盘 → 回填 audio_assets；请求体带 voice/instructions', async () => {
  const f = await fixture('未命中')
  try {
    const { res, body } = await preview(f.app, f.episodeId, f.lineId)
    assert.equal(res.statusCode, 200)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0]!.voice, 'Cherry')
    assert.equal(f.calls[0]!.instructions, '热情一点')
    assert.equal(f.calls[0]!.text, '欢迎收听本期节目')

    assert.equal(body.asset.url, `/api/media/${f.wsId}/${f.episodeId}/assets/${f.lineId}`)
    assert.equal(body.asset.durationMs, 1000)
    assert.match(body.asset.id, /^[0-9a-f-]{36}$/)

    // DB 回填：audio_ref 相对 MEDIA_ROOT，行唯一
    const rows = await f.app.db.select().from(audioAssets).where(eq(audioAssets.scriptLineId, f.lineId))
    assert.equal(rows.length, 1)
    const ref = rows[0]!.audioRef
    assert.equal(ref, `ws-${f.wsId}/ep-${f.episodeId}/assets/${f.lineId}.wav`)
    assert.equal(rows[0]!.durationMs, 1000)

    // 文件落盘且内容 = stub wav
    const file = await readFile(join(f.mediaRoot, ref))
    assert.deepEqual(file, makeWav({ dataBytes: 48000 }))

    // GET script 投影 asset.has 翻转
    const script = (
      (await f.app.inject({ method: 'GET', url: `/api/episodes/${f.episodeId}/script` })).json() as {
        lines: { id: string; asset: { has: boolean; durationMs: number | null } }[]
      }
    )
    assert.deepEqual(script.lines.find((l) => l.id === f.lineId)!.asset, { has: true, durationMs: 1000 })
  } finally {
    await teardown(f.app, f.mediaRoot, f.wsId)
  }
})

test('preview 命中：二次试听不再调 TTS；force:true 强制重生成（同 id 覆盖）', async () => {
  const f = await fixture('命中与force')
  try {
    const first = await preview(f.app, f.episodeId, f.lineId)
    assert.equal(first.res.statusCode, 200)
    assert.equal(f.calls.length, 1)

    // 命中：不调 TTS，同 asset
    const second = await preview(f.app, f.episodeId, f.lineId)
    assert.equal(second.res.statusCode, 200)
    assert.equal(f.calls.length, 1)
    assert.equal(second.body.asset.id, first.body.asset.id)

    // force：重调 TTS，文件覆盖，asset id 不变（upsert 同行）
    const forced = await preview(f.app, f.episodeId, f.lineId, { force: true })
    assert.equal(forced.res.statusCode, 200)
    assert.equal(f.calls.length, 2)
    assert.equal(forced.body.asset.id, first.body.asset.id)
    const rows = await f.app.db.select().from(audioAssets).where(eq(audioAssets.scriptLineId, f.lineId))
    assert.equal(rows.length, 1)
  } finally {
    await teardown(f.app, f.mediaRoot, f.wsId)
  }
})

test('改台词作废素材：POST /changes 删行素材，下次 preview 重新合成并带新文本', async () => {
  const f = await fixture('作废重合成')
  try {
    await preview(f.app, f.episodeId, f.lineId)
    assert.equal(f.calls.length, 1)

    const changed = await f.app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/changes`,
      payload: { ops: [{ op: 'edit', lineId: f.lineId, patch: { text: '改过的台词' } }] },
    })
    assert.equal(changed.statusCode, 200)
    assert.deepEqual((changed.json() as { invalidatedLineIds: string[] }).invalidatedLineIds, [f.lineId])
    assert.equal(
      (await f.app.db.select().from(audioAssets).where(eq(audioAssets.scriptLineId, f.lineId))).length,
      0,
    )

    const next = await preview(f.app, f.episodeId, f.lineId)
    assert.equal(next.res.statusCode, 200)
    assert.equal(f.calls.length, 2)
    assert.equal(f.calls[1]!.text, '改过的台词')
  } finally {
    await teardown(f.app, f.mediaRoot, f.wsId)
  }
})

test('错误语义：行不存在 404；TTS 失败 → 502 {error:{code:SYNTH_FAILED}}；force 形状错 400', async () => {
  const f = await fixture('错误语义')
  try {
    const missing = await preview(f.app, f.episodeId, '00000000-0000-4000-8000-00000000000f')
    assert.equal(missing.res.statusCode, 404)

    const badForce = await f.app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/lines/${f.lineId}/preview`,
      payload: { force: 'yes' },
    })
    assert.equal(badForce.statusCode, 400)

    // 换上必炸的 TTS stub：SYNTH_FAILED 按 {error} 透传，不吞成裸 5xx
    const { AppError } = await import('../src/shared/errors.js')
    f.app.tts = {
      async synthesize() {
        throw new AppError('SYNTH_FAILED', 'TTS 上游错误 InvalidApiKey：bad key', 502)
      },
    }
    const failed = await preview(f.app, f.episodeId, f.lineId)
    assert.equal(failed.res.statusCode, 502)
    assert.equal(failed.body.error!.code, 'SYNTH_FAILED')
    assert.match(failed.body.error!.message, /InvalidApiKey/)
  } finally {
    await teardown(f.app, f.mediaRoot, f.wsId)
  }
})

test('GET /media assets：200 全量 + Range 206 分段 + 416 + 404', async () => {
  const f = await fixture('媒体流式')
  try {
    const { body } = await preview(f.app, f.episodeId, f.lineId)
    const url = body.asset.url
    const wav = makeWav({ dataBytes: 48000 })
    const total = wav.length

    const full = await f.app.inject({ method: 'GET', url })
    assert.equal(full.statusCode, 200)
    assert.equal(full.headers['content-type'], 'audio/wav')
    assert.equal(full.headers['accept-ranges'], 'bytes')
    assert.equal(full.headers['cache-control'], 'no-store')
    assert.equal(full.headers['content-length'], String(total))
    assert.deepEqual(full.rawPayload, wav)

    const head = await f.app.inject({ method: 'GET', url: url, headers: { range: 'bytes=0-3' } })
    assert.equal(head.statusCode, 206)
    assert.equal(head.headers['content-range'], `bytes 0-3/${total}`)
    assert.deepEqual(head.rawPayload, wav.subarray(0, 4))
    assert.deepEqual(head.rawPayload.toString('ascii'), 'RIFF')

    const tail = await f.app.inject({ method: 'GET', url, headers: { range: `bytes=${total - 100}-` } })
    assert.equal(tail.statusCode, 206)
    assert.equal(tail.headers['content-range'], `bytes ${total - 100}-${total - 1}/${total}`)
    assert.equal(tail.headers['content-length'], '100')

    const suffix = await f.app.inject({ method: 'GET', url, headers: { range: 'bytes=-64' } })
    assert.equal(suffix.statusCode, 206)
    assert.equal(suffix.headers['content-range'], `bytes ${total - 64}-${total - 1}/${total}`)

    const outOfRange = await f.app.inject({ method: 'GET', url, headers: { range: `bytes=${total + 10}-` } })
    assert.equal(outOfRange.statusCode, 416)
    assert.equal(outOfRange.headers['content-range'], `bytes */${total}`)

    const malformed = await f.app.inject({ method: 'GET', url, headers: { range: 'bytes=abc-def' } })
    // 语法非法的 Range 按 RFC 7233 忽略 → 全量 200
    assert.equal(malformed.statusCode, 200)
    assert.equal(malformed.headers['content-length'], String(total))
    const multiRange = await f.app.inject({ method: 'GET', url, headers: { range: 'bytes=0-1,3-4' } })
    assert.equal(multiRange.statusCode, 200)

    const missing = await f.app.inject({
      method: 'GET',
      url: `/api/media/${f.wsId}/${f.episodeId}/assets/00000000-0000-4000-8000-00000000000f`,
    })
    assert.equal(missing.statusCode, 404)

    // 非 uuid 行 id 与越界路径都不放行
    assert.equal((await f.app.inject({ method: 'GET', url: `/api/media/${f.wsId}/${f.episodeId}/assets/not-a-uuid` })).statusCode, 404)
    assert.equal(
      (
        await f.app.inject({
          method: 'GET',
          url: `/api/media/${f.wsId}/${f.episodeId}/artifacts/%2e%2e%2fsecret.txt`,
        })
      ).statusCode,
      404,
    )
  } finally {
    await teardown(f.app, f.mediaRoot, f.wsId)
  }
})
