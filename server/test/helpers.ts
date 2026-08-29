import { Buffer } from 'node:buffer'

// 规范 44 字节头 PCM wav（RIFF/WAVE/fmt/data），wav 解析单测与 synthesis stub 共用
export function makeWav(
  opts: { sampleRate?: number; channels?: number; bits?: number; dataBytes?: number } = {},
): Buffer {
  const { sampleRate = 24000, channels = 1, bits = 16, dataBytes = 48000 } = opts
  const blockAlign = (channels * bits) / 8
  const byteRate = sampleRate * blockAlign
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return Buffer.concat([header, Buffer.alloc(dataBytes)])
}
