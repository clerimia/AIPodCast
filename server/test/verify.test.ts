import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DURATION_TOLERANCE_MS, checkMeasuredDuration, checkTranscript } from '../src/modules/post/verify.js'
import { AppError } from '../src/shared/errors.js'

// verify 纯函数单测（docs/audio-params.md 管线第 6 步）；ffprobe 实测在 post-pipeline 集成测试覆盖。

test('checkMeasuredDuration：容差内通过，超 150ms 抛 SYNTH_VERIFY_FAILED', () => {
  checkMeasuredDuration(10_000, 10_000 + DURATION_TOLERANCE_MS, '总时长')
  checkMeasuredDuration(10_000, 10_000 - DURATION_TOLERANCE_MS, '总时长')

  assert.throws(
    () => checkMeasuredDuration(10_000, 10_000 + DURATION_TOLERANCE_MS + 0.5, '总时长'),
    (err: unknown) => err instanceof AppError && err.code === 'SYNTH_VERIFY_FAILED',
  )
  assert.throws(
    () => checkMeasuredDuration(10_000, Number.NaN, '总时长'),
    (err: unknown) => err instanceof AppError && err.code === 'SYNTH_VERIFY_FAILED',
  )
})

test('checkTranscript：行数/行内起止/单调连续', () => {
  const ok = [
    { serial: 'L001', speakerName: '甲', text: '一', startMs: 0, endMs: 1000 },
    { serial: 'L002', speakerName: '乙', text: '二', startMs: 1400, endMs: 2600 },
  ]
  checkTranscript(ok, 2)

  // 行数不符
  assert.throws(() => checkTranscript(ok, 3), /行数不符/)
  // 非单调：第二行早于第一行结束
  assert.throws(
    () =>
      checkTranscript(
        [
          { serial: 'L001', speakerName: '甲', text: '一', startMs: 0, endMs: 1000 },
          { serial: 'L002', speakerName: '乙', text: '二', startMs: 900, endMs: 2000 },
        ],
        2,
      ),
    /非单调/,
  )
  // 行内起止非正
  assert.throws(
    () => checkTranscript([{ serial: 'L001', speakerName: '甲', text: '一', startMs: 500, endMs: 500 }], 1),
    /非正/,
  )
})
