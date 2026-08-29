// 媒体流式（ADR-0008：文件经 GET /api/media/... 流式读取，支持 Range——
// <audio> 拖动进度必需）。纯函数：算好状态码/头/payload 由路由 handler `return`
//（fastify 约定：handler 内直发再 resolve undefined 会被二次 send(undefined) 冲掉
// Content-Length，见 wrap-thenable）。只读、不写业务状态；路径由 uuid 推导 +
// 产物文件名白名单，无路径穿越面。文件缺失 → 404。
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { AppError } from '../../shared/errors.js'

// Content-Type 按扩展名（docs/api-and-dataflow.md「通用约定」）
const CONTENT_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
}

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** MEDIA_ROOT 下 ws-/ep- 目录的文件绝对路径（调用方已校验 kind 与 name 形状） */
export function mediaFilePath(
  mediaRoot: string,
  wsId: string,
  episodeId: string,
  kind: 'assets' | 'artifacts',
  name: string,
): string {
  return join(mediaRoot, `ws-${wsId}`, `ep-${episodeId}`, kind, name)
}

export interface ByteRange {
  start: number
  end: number
}

/**
 * 解析 Range 头（只认 bytes 单一区间）。无头 → null（全量 200）；
 * 语法非法（含多区间）按 RFC 7233 忽略 → null（全量 200）；
 * 语法合法但区间落在文件外 → 'unsatisfiable'（416）；否则夹紧 end 到 size-1。
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === undefined || rawEnd === undefined) return null
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable'
  if (size === 0) return 'unsatisfiable'

  // 后缀区间 bytes=-N：最后 N 字节（N 超长时取整个文件）
  if (rawStart === '') {
    const suffix = Number.parseInt(rawEnd, 10)
    if (suffix <= 0) return 'unsatisfiable'
    const length = Math.min(suffix, size)
    return { start: size - length, end: size - 1 }
  }

  const start = Number.parseInt(rawStart, 10)
  if (start >= size) return 'unsatisfiable'
  const end = rawEnd === '' ? size - 1 : Math.min(Number.parseInt(rawEnd, 10), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

export type MediaPayload = NodeJS.ReadableStream | Record<string, unknown>

export interface PreparedPayload {
  statusCode: number
  headers: Record<string, string>
  payload: MediaPayload
}

/**
 * stat → 组装状态码/头/payload（handler `return` 它，fastify 单次发送）。
 * stat 失败 = 文件缺失（404）；Range 无法满足 → 416 JSON 体。
 * 素材会被 force 重生成原路覆盖（同 URL），故 no-store：浏览器不缓存，重生成后必取新字节。
 */
export async function prepareMediaPayload(
  filePath: string,
  contentType: string,
  rangeHeader: string | undefined,
): Promise<PreparedPayload> {
  let size: number
  try {
    size = (await stat(filePath)).size
  } catch {
    throw new AppError('NOT_FOUND', 'media file not found', 404)
  }

  const range = parseRange(rangeHeader, size)

  if (range === 'unsatisfiable') {
    return {
      statusCode: 416,
      headers: { 'Content-Type': 'application/json', 'Content-Range': `bytes */${size}` },
      payload: { error: { code: 'RANGE_NOT_SATISFIABLE', message: 'requested range not satisfiable' } },
    }
  }

  const baseHeaders = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }

  if (range) {
    return {
      statusCode: 206,
      headers: {
        ...baseHeaders,
        'Content-Type': contentType,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(range.end - range.start + 1),
      },
      payload: createReadStream(filePath, { start: range.start, end: range.end }),
    }
  }

  return {
    statusCode: 200,
    headers: { ...baseHeaders, 'Content-Type': contentType, 'Content-Length': String(size) },
    payload: createReadStream(filePath),
  }
}
