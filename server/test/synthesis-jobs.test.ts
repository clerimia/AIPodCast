import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { and, eq, inArray } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { artifacts, audioAssets, episodes, scriptLines, synthesisJobs, workspaces } from '../src/db/schema.js'
import type { TtsClient, TtsInput } from '../src/modules/synthesis/tts.js'
import { AppError } from '../src/shared/errors.js'
import { makeWav } from './helpers.js'

// M5 synthesis jobs 集成测试（docs/api-and-dataflow.md「试听 / 整集合成 / 产物」+
// docs/synthesis-progress-and-cancel.md 的 M5 落点）：真 DB + 真 ffmpeg post 流水线 +
// stub TTS + 隔离 MEDIA_ROOT。覆盖：端到端成功（202 → 轮询 → artifact → 媒体流）、
// 409 并发守卫、preview 行级互斥、单行失败 → failed（SYNTH_LINE_FAILED）、
// 验证失败 → failed 且旧产物完好（ADR-0007）、重启孤儿任务 → interrupted。

type App = Awaited<ReturnType<typeof buildApp>>

type TtsBehavior = (input: TtsInput, nth: number) => Promise<Buffer> | Buffer

function stubTts(behavior: TtsBehavior = () => makeWav({ dataBytes: 24000, sine: true })): {
  tts: TtsClient
  calls: TtsInput[]
} {
  const calls: TtsInput[] = []
  return {
    calls,
    tts: {
      async synthesize(input) {
        calls.push(input)
        return behavior(input, calls.length - 1)
      },
    },
  }
}

interface Fixture {
  app: App
  wsId: string
  episodeId: string
  lineIds: string[]
  mediaRoot: string
  calls: TtsInput[]
}

/** 默认两行、同一说话人（gap = 集级默认 中 800ms）；0.5s 素材 ×2 → 期望 master 1.8s */
async function fixture(title: string, opts: { lineCount?: number; showNotes?: string } = {}): Promise<Fixture> {
  const mediaRoot = await mkdtemp(join(tmpdir(), 'aipodcast-jobs-'))
  const stub = stubTts()
  const app = await buildApp({ mediaRoot, tts: stub.tts })
  const ws = (
    (await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'M5 工作间' } })).json() as {
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
    (await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/episodes`, payload: { title } })).json() as {
      id: string
    }
  )
  if (opts.showNotes !== undefined) {
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/episodes/${ep.id}`,
      payload: { showNotes: opts.showNotes },
    })
    assert.equal(patched.statusCode, 200)
  }
  const lineCount = opts.lineCount ?? 2
  // 客户端预生成 id 链式 afterLineId：serial 顺序确定性（L001 → L002 → …）
  const ids = Array.from({ length: lineCount }, () => randomUUID())
  const changed = await app.inject({
    method: 'POST',
    url: `/api/episodes/${ep.id}/changes`,
    payload: {
      ops: ids.map((id, i) => ({
        op: 'add',
        id,
        afterLineId: i === 0 ? null : ids[i - 1]!,
        speakerId: speaker.id,
        text: `第${i + 1}句台词`,
        instructions: '平静',
      })),
    },
  })
  assert.equal(changed.statusCode, 200)
  return {
    app,
    wsId: ws.id,
    episodeId: ep.id,
    lineIds: (changed.json() as { lines: { id: string }[] }).lines.map((l) => l.id),
    mediaRoot,
    calls: stub.calls,
  }
}

async function teardown(f: Fixture): Promise<void> {
  // script_lines.speaker_id 外键无级联动作，先清行再删工作间（与其余测试一致）
  await f.app.db
    .delete(scriptLines)
    .where(
      inArray(
        scriptLines.episodeId,
        f.app.db.select({ id: episodes.id }).from(episodes).where(eq(episodes.wsId, f.wsId)),
      ),
    )
  await f.app.db.delete(workspaces).where(eq(workspaces.id, f.wsId))
  await f.app.close()
  await rm(f.mediaRoot, { recursive: true, force: true })
}

async function synthesize(f: Fixture): Promise<{ res: { statusCode: number }; body: { jobId: string; statusUrl: string; error?: { code: string; message: string } } }> {
  const res = await f.app.inject({ method: 'POST', url: `/api/episodes/${f.episodeId}/synthesize` })
  return { res, body: res.json() }
}

async function getJob(app: App, jobId: string): Promise<Record<string, unknown> & { status: string; error?: unknown }> {
  const res = await app.inject({ method: 'GET', url: `/api/synthesis-jobs/${jobId}` })
  return res.json()
}

async function waitJobStatus(app: App, jobId: string, statuses: string[], timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = await getJob(app, jobId)
    if (statuses.includes(job.status)) return job
    assert.ok(Date.now() < deadline, `job 未在限时内到达 ${statuses.join('/')}（现 ${job.status}）`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const artifactDir = (f: Fixture) => join(f.mediaRoot, `ws-${f.wsId}`, `ep-${f.episodeId}`, 'artifacts')

test('端到端成功：202 句柄 → 轮询 succeeded → artifact 元数据+transcript → 整包落盘 → master 流式', async () => {
  const f = await fixture('端到端', { showNotes: '这是一集关于合成流水线的节目' })
  try {
    const { res, body } = await synthesize(f)
    assert.equal(res.statusCode, 202)
    assert.match(body.jobId, /^[0-9a-f-]{36}$/)
    assert.equal(body.statusUrl, `/api/synthesis-jobs/${body.jobId}`)

    const job = await waitJobStatus(f.app, body.jobId, ['succeeded'])
    assert.equal(job.totalLines, 2)
    assert.equal(job.doneLines, 2)
    assert.deepEqual(job.doneLineIds, f.lineIds)
    assert.equal(job.stage, 'encode')
    assert.equal(job.error, null)

    // TTS 逐行都调了（未命中 → 合成回填）
    assert.deepEqual(
      f.calls.map((c) => c.text),
      ['第1句台词', '第2句台词'],
    )

    // artifact 视图：master + transcript 快照（0.5s ×2 + 800ms gap = 1.8s）
    const artRes = await f.app.inject({ method: 'GET', url: `/api/episodes/${f.episodeId}/artifact` })
    assert.equal(artRes.statusCode, 200)
    const art = artRes.json() as {
      id: string
      createdAt: string
      durationMs: number
      size: number
      audioUrl: string
      transcriptUrl: string
      notesUrl: string
      transcript: { serial: string; speakerName: string; text: string; startMs: number; endMs: number }[]
      notes: string | null
    }
    assert.equal(art.audioUrl, `/api/media/${f.wsId}/${f.episodeId}/artifacts/master.mp3`)
    assert.equal(art.transcriptUrl, `/api/media/${f.wsId}/${f.episodeId}/artifacts/transcript.json`)
    assert.equal(art.notesUrl, `/api/media/${f.wsId}/${f.episodeId}/artifacts/notes.md`)
    assert.equal(art.notes, '这是一集关于合成流水线的节目')
    assert.ok(Math.abs(art.durationMs - 1800) <= 150, `durationMs ${art.durationMs}`)
    assert.deepEqual(
      art.transcript.map((t) => [t.serial, t.startMs, t.endMs]),
      [
        ['L001', 0, 500],
        ['L002', 1300, 1800],
      ],
    )
    assert.deepEqual(
      art.transcript.map((t) => t.text),
      ['第1句台词', '第2句台词'],
    )
    // job 快照里 artifact 与 GET artifact 同形
    assert.deepEqual((job as unknown as { artifact: unknown }).artifact, art)

    // 整包落盘：三个文件 + DB 行
    const masterBytes = await readFile(join(artifactDir(f), 'master.mp3'))
    assert.equal((await stat(join(artifactDir(f), 'transcript.json'))).size > 0, true)
    assert.equal(await readFile(join(artifactDir(f), 'notes.md'), 'utf8'), '这是一集关于合成流水线的节目')
    const rows = await f.app.db.select().from(artifacts).where(eq(artifacts.episodeId, f.episodeId))
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.durationMs, art.durationMs)

    // master.mp3 可经媒体端点流式（Content-Type audio/mpeg）
    const media = await f.app.inject({ method: 'GET', url: art.audioUrl })
    assert.equal(media.statusCode, 200)
    assert.equal(media.headers['content-type'], 'audio/mpeg')
    assert.deepEqual(media.rawPayload, masterBytes)

    // 素材回填进 audio_assets（行级复用）
    const assets = await f.app.db
      .select()
      .from(audioAssets)
      .where(inArray(audioAssets.scriptLineId, f.lineIds))
    assert.equal(assets.length, 2)

    // 终态后重复轮询拿到同形快照
    assert.equal((await getJob(f.app, body.jobId)).status, 'succeeded')
  } finally {
    await teardown(f)
  }
})

test('并发守卫与 preview 行级互斥：活跃任务期间再合成 409；未完成行 preview 409、已完成行照常', async () => {
  const f = await fixture('并发与互斥')
  try {
    // TTS 首行挂起（deferred），任务停在 tts 阶段
    let release0: (() => void) | null = null
    const gate0 = new Promise<void>((resolve) => {
      release0 = resolve
    })
    let release1: (() => void) | null = null
    const gate1 = new Promise<void>((resolve) => {
      release1 = resolve
    })
    const calls: TtsInput[] = []
    const deferred = {
      async synthesize(input: TtsInput) {
        calls.push(input)
        if (calls.length === 1) await gate0
        if (calls.length === 2) await gate1
        return makeWav({ dataBytes: 24000, sine: true })
      },
    }
    // 编排走 jobs.deps.tts（构造时捕获），preview 路由走 app.tts——两处一致替换
    f.app.tts = deferred
    f.app.jobs.deps.tts = deferred

    const { body } = await synthesize(f)
    // 等到首行成为 currentLine（TTS 在途）
    const deadline = Date.now() + 10_000
    for (;;) {
      const job = await getJob(f.app, body.jobId)
      if ((job.currentLine as { lineId: string } | null)?.lineId === f.lineIds[0]) break
      assert.ok(Date.now() < deadline, '任务未进入 tts 首行')
      await new Promise((r) => setTimeout(r, 25))
    }

    // 活跃期间再合成 → 409
    assert.equal((await synthesize(f)).res.statusCode, 409)
    // 未完成行（排队中）preview → 409 该行合成中
    const locked = await f.app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/lines/${f.lineIds[1]}/preview`,
    })
    assert.equal(locked.statusCode, 409)
    assert.equal((locked.json() as { error: { code: string } }).error.code, 'CONFLICT')

    release0!()
    // 首行完成、第二行在途：已合成行 preview 照常（行级互斥非整集封锁）
    const deadline2 = Date.now() + 10_000
    for (;;) {
      const job = await getJob(f.app, body.jobId)
      const done = (job.doneLineIds as string[]) ?? []
      if (done.includes(f.lineIds[0]!)) break
      assert.ok(Date.now() < deadline2, '首行未完成')
      await new Promise((r) => setTimeout(r, 25))
    }
    const unlocked = await f.app.inject({
      method: 'POST',
      url: `/api/episodes/${f.episodeId}/lines/${f.lineIds[0]}/preview`,
    })
    assert.equal(unlocked.statusCode, 200)

    release1!()
    await waitJobStatus(f.app, body.jobId, ['succeeded'])
  } finally {
    await teardown(f)
  }
})

test('单行失败：TTS 持续 5xx → 重试 1 次仍败 → failed（SYNTH_LINE_FAILED 带行），不落产物', async () => {
  const f = await fixture('行失败')
  try {
    const failing = {
      async synthesize() {
        throw new AppError('SYNTH_FAILED', 'TTS 上游错误 500：boom', 502)
      },
    }
    f.app.tts = failing
    f.app.jobs.deps.tts = failing
    f.app.jobs.deps.lineRetryBackoffMs = 1
    const { body } = await synthesize(f)
    const job = await waitJobStatus(f.app, body.jobId, ['failed'])
    const error = job.error as { code: string; message: string; lineId?: string; serial?: string }
    assert.equal(error.code, 'SYNTH_LINE_FAILED')
    assert.equal(error.lineId, f.lineIds[0])
    assert.equal(error.serial, 'L001')
    assert.match(error.message, /L001/)
    // 失败不落产物：artifact 404、artifacts 表无行、素材未回填
    assert.equal(
      (await f.app.inject({ method: 'GET', url: `/api/episodes/${f.episodeId}/artifact` })).statusCode,
      404,
    )
    assert.equal(
      (await f.app.db.select().from(artifacts).where(eq(artifacts.episodeId, f.episodeId))).length,
      0,
    )
    // 临时目录清理
    await assert.rejects(stat(join(f.mediaRoot, 'tmp', body.jobId)))
  } finally {
    await teardown(f)
  }
})

test('验证失败：任务 failed 且旧产物完好未覆盖（ADR-0007 整包替换只在验证通过后）', async () => {
  const f = await fixture('验证失败保旧')
  try {
    // 第一次：真流水线成功，留下产物
    const first = await synthesize(f)
    assert.equal(first.res.statusCode, 202)
    await waitJobStatus(f.app, first.body.jobId, ['succeeded'])
    const oldArtifact = (
      await f.app.inject({ method: 'GET', url: `/api/episodes/${f.episodeId}/artifact` })
    ).json() as { id: string; durationMs: number }
    const oldMaster = await readFile(join(artifactDir(f), 'master.mp3'))

    // 第二次：流水线验证失败
    f.app.jobs.deps.runPipeline = async () => {
      throw new AppError('SYNTH_VERIFY_FAILED', '确定性验证不过：期望 9999ms', 500)
    }
    const second = await synthesize(f)
    const job = await waitJobStatus(f.app, second.body.jobId, ['failed'])
    assert.equal((job.error as { code: string }).code, 'SYNTH_VERIFY_FAILED')
    assert.match((job.error as { message: string }).message, /9999/)

    // 旧产物完好：同一行、同一字节、GET artifact 原样
    const artRes = await f.app.inject({ method: 'GET', url: `/api/episodes/${f.episodeId}/artifact` })
    const art = artRes.json() as { id: string; durationMs: number }
    assert.equal(art.id, oldArtifact.id)
    assert.equal(art.durationMs, oldArtifact.durationMs)
    assert.deepEqual(await readFile(join(artifactDir(f), 'master.mp3')), oldMaster)
    assert.equal(await f.app.db.select().from(artifacts).where(eq(artifacts.episodeId, f.episodeId)).then((r) => r.length), 1)
  } finally {
    await teardown(f)
  }
})

test('重启收场：非终态孤儿任务启动时标 interrupted；残留任务临时目录被清理；已知 jobId 可查', async () => {
  const f = await fixture('重启收场')
  try {
    // 模拟崩溃遗留：running 任务行 + 任务临时目录
    await f.app.db.insert(synthesisJobs).values({
      episodeId: f.episodeId,
      status: 'running',
      stage: 'tts',
      plan: f.lineIds,
      doneLineIds: [],
      currentLine: { lineId: f.lineIds[0]!, serial: 'L001' },
    })
    const staleDir = join(f.mediaRoot, 'tmp', 'stale-job')
    await mkdir(staleDir, { recursive: true })
    await writeFile(join(staleDir, 'leftover.wav'), 'x')

    // 新进程（同 DB 同 MEDIA_ROOT）：buildApp 内 recover()
    const fresh = await buildApp({ mediaRoot: f.mediaRoot, tts: f.app.tts })
    try {
      const rows = await fresh.db
        .select()
        .from(synthesisJobs)
        .where(eq(synthesisJobs.episodeId, f.episodeId))
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.status, 'interrupted')
      assert.equal((rows[0]!.error as { code: string }).code, 'INTERRUPTED')
      // stage 定格在最后所处阶段
      assert.equal(rows[0]!.stage, 'tts')

      const job = await fresh.inject({
        method: 'GET',
        url: `/api/synthesis-jobs/${rows[0]!.id}`,
      })
      const body = job.json() as { status: string; error: { code: string } }
      assert.equal(job.statusCode, 200)
      assert.equal(body.status, 'interrupted')
      assert.equal(body.error.code, 'INTERRUPTED')

      // 残留临时目录已被 recover 清理（tmp 整目录移除；放在再合成前，新任务会重建 tmp）
      await assert.rejects(stat(join(f.mediaRoot, 'tmp', 'stale-job')))
      await assert.rejects(stat(join(f.mediaRoot, 'tmp')))

      // interrupted 是终态：不阻塞新一轮合成
      const again = await fresh.inject({ method: 'POST', url: `/api/episodes/${f.episodeId}/synthesize` })
      assert.equal(again.statusCode, 202)
      await waitJobStatus(fresh, (again.json() as { jobId: string }).jobId, ['succeeded'])
    } finally {
      await fresh.close()
    }
  } finally {
    await teardown(f)
  }
})

test('边界：无行脚本 400；未知单集 404；未知任务 404；重复素材命中不重复 TTS', async () => {
  const f = await fixture('边界', { lineCount: 1 })
  try {
    const emptyEp = (
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/workspaces/${f.wsId}/episodes`,
          payload: { title: '空脚本' },
        })
      ).json() as { id: string }
    )
    const emptyRes = await f.app.inject({ method: 'POST', url: `/api/episodes/${emptyEp.id}/synthesize` })
    assert.equal(emptyRes.statusCode, 400)

    const missingEp = await f.app.inject({
      method: 'POST',
      url: '/api/episodes/00000000-0000-4000-8000-00000000000f/synthesize',
    })
    assert.equal(missingEp.statusCode, 404)

    const missingJob = await f.app.inject({
      method: 'GET',
      url: '/api/synthesis-jobs/00000000-0000-4000-8000-00000000000f',
    })
    assert.equal(missingJob.statusCode, 404)

    // 成功后再合成：素材命中复用（第二轮零 TTS 调用）
    const first = await synthesize(f)
    await waitJobStatus(f.app, first.body.jobId, ['succeeded'])
    assert.equal(f.calls.length, 1)
    const second = await synthesize(f)
    assert.equal(second.res.statusCode, 202)
    await waitJobStatus(f.app, second.body.jobId, ['succeeded'])
    assert.equal(f.calls.length, 1)
  } finally {
    await teardown(f)
  }
})

test('级联清理：删工作间带走该集任务行与产物行（synthesis_jobs/artifacts FK cascade）', async () => {
  const f = await fixture('级联')
  try {
    const { body } = await synthesize(f)
    await waitJobStatus(f.app, body.jobId, ['succeeded'])
    const countJobs = async () =>
      (await f.app.db.select().from(synthesisJobs).where(eq(synthesisJobs.episodeId, f.episodeId))).length
    assert.equal(await countJobs(), 1)
    await f.app.db.delete(scriptLines).where(eq(scriptLines.episodeId, f.episodeId))
    await f.app.db.delete(workspaces).where(eq(workspaces.id, f.wsId))
    assert.equal(await countJobs(), 0)
    assert.equal(
      (await f.app.db.select().from(artifacts).where(eq(artifacts.episodeId, f.episodeId))).length,
      0,
    )
  } finally {
    await f.app.close()
    await rm(f.mediaRoot, { recursive: true, force: true })
  }
})
