// WAV 头解析：从 PCM wav 字节算时长（素材固定引擎输出 wav 24k mono 16-bit，
// DashScope 不回传时长，本地按 RIFF fmt.byteRate + data.size 推导）。
// 解析失败（非 RIFF/缺 fmt/byteRate 0）返回 null，不抛错——时长仅作展示/命中元数据。
// post 流水线（M5）用 wavPcmDurationMs 的非取整值做确定性时间戳计算。

const RIFF = 0x52494646 // 'RIFF'
const WAVE = 0x57415645 // 'WAVE'

/** 解析 fmt.byteRate 与 data.size（头声明与实际 payload 取小者，截断容错） */
export function wavPcmInfo(bytes: Buffer): { byteRate: number; dataSize: number } | null {
  if (bytes.length < 12) return null
  if (bytes.readUInt32BE(0) !== RIFF || bytes.readUInt32BE(8) !== WAVE) return null

  let byteRate: number | null = null
  let dataSize: number | null = null
  // 走 chunk 链：id(4) size(4) payload(+奇数补位)；取 fmt 的 byteRate 与 data 的 size
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = bytes.readUInt32BE(offset)
    const size = bytes.readUInt32LE(offset + 4)
    if (id === 0x666d7420 /* 'fmt ' */ && offset + 16 <= bytes.length) {
      byteRate = bytes.readUInt32LE(offset + 16)
    } else if (id === 0x64617461 /* 'data' */) {
      // 头声明的 size 可能大于实际 payload（截断容错），取小者
      dataSize = Math.min(size, bytes.length - (offset + 8))
    }
    offset += 8 + size + (size % 2)
  }

  if (byteRate === null || byteRate <= 0 || dataSize === null) return null
  return { byteRate, dataSize }
}

/** 时长 ms（取整；展示/命中元数据用） */
export function wavDurationMs(bytes: Buffer): number | null {
  const info = wavPcmInfo(bytes)
  if (!info) return null
  return Math.round((info.dataSize / info.byteRate) * 1000)
}

/** 时长 ms（非取整；post 确定性时间戳计算用，避免逐行 1ms 舍入跨行累积） */
export function wavPcmDurationMs(bytes: Buffer): number | null {
  const info = wavPcmInfo(bytes)
  if (!info) return null
  return (info.dataSize / info.byteRate) * 1000
}
