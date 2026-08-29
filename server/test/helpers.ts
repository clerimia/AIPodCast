import { Buffer } from 'node:buffer'

// 规范 44 字节头 PCM wav（RIFF/WAVE/fmt/data），wav 解析单测与 synthesis stub 共用。
// sine: true 时 data 区填 220Hz 正弦（post 流水线测试用——数字静音过 loudnorm 是退化输入）
export function makeWav(
  opts: { sampleRate?: number; channels?: number; bits?: number; dataBytes?: number; sine?: boolean } = {},
): Buffer {
  const { sampleRate = 24000, channels = 1, bits = 16, dataBytes = 48000, sine = false } = opts
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
  const data = Buffer.alloc(dataBytes)
  if (sine) {
    const step = (2 * Math.PI * 220) / sampleRate
    for (let i = 0; i + 2 <= dataBytes; i += 2) {
      data.writeInt16LE(Math.round(Math.sin(i / 2 * step) * 12000), i)
    }
  }
  return Buffer.concat([header, data])
}
