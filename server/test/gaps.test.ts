import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeGaps, PAUSE_GAP_MS, SPEAKER_CHANGE_EXTRA_MS, SPEED_FACTOR } from '../src/modules/post/gaps.js'

// gaps 单测（docs/audio-params.md 档位表）：档位数值、gap 归属（后一行的 pause 档）、换说话人 +400 叠加。

test('档位数值表：停顿 短/中/长 = 400/800/1500，语速 慢/正常/快 = 0.9/1.0/1.15', () => {
  assert.deepEqual(PAUSE_GAP_MS, { 短: 400, 中: 800, 长: 1500 })
  assert.deepEqual(SPEED_FACTOR, { 慢: 0.9, 正常: 1.0, 快: 1.15 })
  assert.equal(SPEAKER_CHANGE_EXTRA_MS, 400)
})

test('computeGaps：首行 0；gap 取后一行 pause 档位（override 优先集级默认）', () => {
  const lines = [
    { speakerId: 'a', post: {} },
    { speakerId: 'a', post: { pause: '长' as const } },
    { speakerId: 'a', post: {} },
  ]
  const gaps = computeGaps(lines, { pause: '中', speed: '正常' })
  // line0 无 gap；line1 逐行 override 长=1500；line2 无 override → 集级默认 中=800
  assert.deepEqual(gaps, [0, 1500, 800])
})

test('computeGaps：换说话人叠加 +400（默认档位与逐行 override 下都生效）', () => {
  const sameSpeaker = [
    { speakerId: 'a', post: {} },
    { speakerId: 'a', post: {} },
  ]
  assert.deepEqual(computeGaps(sameSpeaker, { pause: '中', speed: '正常' }), [0, 800])

  const speakerChange = [
    { speakerId: 'a', post: {} },
    { speakerId: 'b', post: {} },
  ]
  // 默认（中）+ 换说话人：800 + 400 = 1200
  assert.deepEqual(computeGaps(speakerChange, { pause: '中', speed: '正常' }), [0, 1200])

  const overrideChange = [
    { speakerId: 'a', post: {} },
    { speakerId: 'b', post: { pause: '长' as const } },
  ]
  // 逐行"长"档 + 换说话人：1500 + 400 = 1900
  assert.deepEqual(computeGaps(overrideChange, { pause: '中', speed: '正常' }), [0, 1900])
})
