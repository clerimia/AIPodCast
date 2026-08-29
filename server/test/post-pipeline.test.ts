import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { computeTimeline, runPostPipeline, type PostLineInput } from '../src/modules/post/pipeline.js'
import { ffprobeDurationMs } from '../src/modules/post/verify.js'
import { AppError } from '../src/shared/errors.js'
import { makeWav } from './helpers.js'

// post 流水线集成测试（真 ffmpeg 8.x，docs/audio-params.md 七步）：时间戳数学、gap/atempo
// 生效、loudnorm 两遍、确定性验证与 mp3 编码。素材用短正弦 wav（秒级），跑得快。

interface LineSpec {
  lineId: string
  serial: string
  speakerName: string
  text: string
  /** 素材 wav 字节数（24000 = 0.5s @24k mono 16-bit） */
  dataBytes: number
  speedFactor?: number
  gapBeforeMs?: number
}

async function setup(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'aipodcast-post-'))
}

async function makeLines(outDir: string, specs: LineSpec[]): Promise<PostLineInput[]> {
  const lines: PostLineInput[] = []
  for (const [i, spec] of specs.entries()) {
    const assetPath = join(outDir, `asset-${i}.wav`)
    await writeFile(assetPath, makeWav({ dataBytes: spec.dataBytes, sine: true }))
    lines.push({
      lineId: `line-${i}`,
      serial: spec.serial,
      speakerName: spec.speakerName,
      text: spec.text,
      assetPath,
      speedFactor: spec.speedFactor ?? 1,
      gapBeforeMs: spec.gapBeforeMs ?? 0,
    })
  }
  return lines
}

test('computeTimeline：start=Σ(前面各行渲染时长+行前gap)，round 后仍单调', () => {
  // 500ms 行 ×2 + 行间 800ms gap（后一行带）+ 非 1 语速
  const lines: PostLineInput[] = [
    { lineId: 'a', serial: 'L001', speakerName: '甲', text: '一', assetPath: 'x', speedFactor: 1.15, gapBeforeMs: 0 },
    { lineId: 'b', serial: 'L002', speakerName: '乙', text: '二', assetPath: 'y', speedFactor: 0.9, gapBeforeMs: 800 },
    { lineId: 'c', serial: 'L003', speakerName: '甲', text: '三', assetPath: 'z', speedFactor: 1, gapBeforeMs: 1200 },
  ]
  // 渲染时长：1000/1.15=869.565…、1000/0.9=1111.11…、1000
  const { transcript, totalMs } = computeTimeline(lines, [1000 / 1.15, 1000 / 0.9, 1000])
  assert.equal(transcript[0]!.startMs, 0)
  assert.equal(transcript[0]!.endMs, Math.round(1000 / 1.15))
  assert.equal(transcript[1]!.startMs, transcript[0]!.endMs + 800)
  assert.equal(transcript[1]!.endMs, transcript[1]!.startMs + Math.round(1000 / 0.9))
  assert.equal(transcript[2]!.startMs, transcript[1]!.endMs + 1200)
  assert.equal(totalMs, transcript[2]!.endMs)
  for (let i = 1; i < transcript.length; i++) {
    assert.ok(transcript[i]!.startMs >= transcript[i - 1]!.endMs)
  }
})

test('七步流水线：2 行 + 800ms gap + 快档语速 → master.mp3、transcript 数学、验证通过', async () => {
  const outDir = await setup()
  try {
    // 0.5s + 0.5s，第二行快档 1.15（渲染 ≈434.78ms）+ 800ms gap
    const lines = await makeLines(outDir, [
      { lineId: 'a', serial: 'L001', speakerName: '主持人', text: '开场白', dataBytes: 24000 },
      { lineId: 'b', serial: 'L002', speakerName: '主持人', text: '第二句', dataBytes: 24000, speedFactor: 1.15, gapBeforeMs: 800 },
    ])
    const stages: string[] = []
    const result = await runPostPipeline(lines, outDir, {
      onStage: (s) => {
        stages.push(s)
      },
    })

    assert.deepEqual(stages, ['post', 'verify', 'encode'])
    assert.equal(result.transcript.length, 2)
    assert.equal(result.transcript[0]!.startMs, 0)
    assert.equal(result.transcript[0]!.endMs, 500)
    assert.equal(result.transcript[1]!.startMs, 500 + 800)
    assert.equal(result.transcript[1]!.endMs, 500 + 800 + Math.round(500 / 1.15))

    // 产物文件：master.mp3 存在，实测时长贴期望（≤150ms 容差），size 与 DB 用途一致
    const masterBytes = await readFile(result.masterPath)
    assert.ok(masterBytes.length > 0)
    assert.equal(result.masterPath, join(outDir, 'master.mp3'))
    assert.equal(result.size, (await stat(result.masterPath)).size)
    const measured = await ffprobeDurationMs(result.masterPath)
    const expected = 500 + 800 + 500 / 1.15
    assert.ok(Math.abs(measured - expected) <= 150, `measured ${measured} vs expected ${expected}`)
    assert.ok(Math.abs(result.durationMs - measured) < 1)
    // mp3 魔数：ID3 或 0xFFEx 帧头
    assert.ok(
      masterBytes.subarray(0, 3).toString('ascii') === 'ID3' || masterBytes[0] === 0xff,
      '不是 mp3',
    )
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('七步流水线：换说话人 1200ms gap + 三行两说话人 → 时间戳单调、验证过', async () => {
  const outDir = await setup()
  try {
    const lines = await makeLines(outDir, [
      { lineId: 'a', serial: 'L001', speakerName: '主持人', text: '甲', dataBytes: 24000 },
      { lineId: 'b', serial: 'L002', speakerName: '嘉宾', text: '乙', dataBytes: 24000, gapBeforeMs: 1200 },
      { lineId: 'c', serial: 'L003', speakerName: '主持人', text: '丙', dataBytes: 24000, gapBeforeMs: 1200 },
    ])
    const result = await runPostPipeline(lines, outDir)
    const expected = 500 + 1200 + 500 + 1200 + 500
    assert.ok(Math.abs(result.durationMs - expected) <= 150, `${result.durationMs} vs ${expected}`)
    assert.deepEqual(
      result.transcript.map((t) => [t.startMs, t.endMs]),
      [
        [0, 500],
        [1700, 2200],
        [3400, 3900],
      ],
    )
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('验证失败分支：素材缺失 / 非 PCM wav → SYNTH_VERIFY_FAILED（旧产物由编排层保全）', async () => {
  const outDir = await setup()
  try {
    const lines = await makeLines(outDir, [
      { lineId: 'a', serial: 'L001', speakerName: '甲', text: '一', dataBytes: 24000 },
      { lineId: 'b', serial: 'L002', speakerName: '甲', text: '二', dataBytes: 24000, gapBeforeMs: 800 },
    ])
    await rm(lines[1]!.assetPath) // 素材文件丢了
    await assert.rejects(
      runPostPipeline(lines, outDir),
      (err: unknown) => err instanceof AppError && err.code === 'SYNTH_VERIFY_FAILED' && /素材缺失/.test(err.message),
    )

    const lines2 = await makeLines(outDir, [
      { lineId: 'a', serial: 'L001', speakerName: '甲', text: '一', dataBytes: 24000 },
    ])
    await writeFile(lines2[0]!.assetPath, Buffer.from('definitely not a riff wav'))
    await assert.rejects(
      runPostPipeline(lines2, outDir),
      (err: unknown) => err instanceof AppError && err.code === 'SYNTH_VERIFY_FAILED' && /有效 PCM wav/.test(err.message),
    )
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})
