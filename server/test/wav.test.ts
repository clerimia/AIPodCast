import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wavDurationMs } from '../src/modules/synthesis/wav.js'
import { makeWav } from './helpers.js'

// WAV 时长解析单测（M4：DashScope 不回传时长，本地按 fmt.byteRate + data.size 推导）

test('24kHz mono 16-bit：byteRate 48000，48000 字节 data → 1000ms', () => {
  const wav = makeWav({ dataBytes: 48000 })
  assert.equal(wavDurationMs(wav), 1000)
})

test('44.1kHz stereo：byteRate 176400，176400 字节 data → 1000ms', () => {
  const wav = makeWav({ sampleRate: 44100, channels: 2, dataBytes: 176400 })
  assert.equal(wavDurationMs(wav), 1000)
})

test('非整毫秒向下取整（round）', () => {
  // byteRate 48000，data 50000 字节 → 1041.666…ms → 1042
  const wav = makeWav({ dataBytes: 50000 })
  assert.equal(wavDurationMs(wav), 1042)
})

test('data 前有附加 chunk（LIST）：仍正确取 fmt/data', () => {
  const wav = makeWav({ dataBytes: 48000 })
  const list = Buffer.alloc(8 + 4) // id + size + payload
  list.write('LIST', 0, 'ascii')
  list.writeUInt32LE(4, 4)
  const spliced = Buffer.concat([wav.subarray(0, 12), list, wav.subarray(12)])
  assert.equal(wavDurationMs(spliced), 1000)
})

test('非 RIFF / 截断 / byteRate 0 → null（不抛错）', () => {
  assert.equal(wavDurationMs(Buffer.from('not a wav at all')), null)
  assert.equal(wavDurationMs(Buffer.alloc(0)), null)
  assert.equal(wavDurationMs(makeWav({ dataBytes: 10 }).subarray(0, 20)), null)

  const zeroRate = makeWav({ dataBytes: 4800 })
  zeroRate.writeUInt32LE(0, 28) // byteRate = 0
  assert.equal(wavDurationMs(zeroRate), null)
})
