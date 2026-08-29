// 产物/媒体模块路由（#19「试听 / 整集合成 / 产物」表）：GET /api/media/* 流式 + Range、
// GET /api/episodes/:id/artifact 产物元数据 + 行级文稿快照（M5）。
// assets 名 = 行 uuid（路由校验）+ 固定 .wav；artifacts 名走白名单（防路径穿越）。
// payload 由 handler `return`，fastify 单次发送。
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../shared/errors.js'
import { requireUuidParam } from '../../shared/validate.js'
import { contentTypeFor, mediaFilePath, prepareMediaPayload } from './media.js'
import { getArtifactView } from './service.js'

interface MediaParams {
  wsId: string
  episodeId: string
  lineId: string
}

interface ArtifactParams {
  wsId: string
  episodeId: string
  file: string
}

interface EpisodeParams {
  episodeId: string
}

// 产物文件包固定三个名字（ADR-0008），白名单即防穿越
const ARTIFACT_FILES = new Set(['master.mp3', 'transcript.json', 'notes.md'])

export async function artifactsRoutes(app: FastifyInstance) {
  app.get<{ Params: EpisodeParams }>('/episodes/:episodeId/artifact', async (req) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    const view = await getArtifactView(app.db, app.mediaRoot, episodeId)
    if (!view) throw new AppError('NOT_FOUND', 'artifact not found', 404)
    return view
  })

  app.get<{ Params: MediaParams }>('/media/:wsId/:episodeId/assets/:lineId', async (req, reply) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    const lineId = requireUuidParam(req.params.lineId, 'line')
    return send(reply, await prepareMediaPayload(
      mediaFilePath(app.mediaRoot, wsId, episodeId, 'assets', `${lineId}.wav`),
      'audio/wav',
      req.headers.range,
    ))
  })

  app.get<{ Params: ArtifactParams }>('/media/:wsId/:episodeId/artifacts/:file', async (req, reply) => {
    requireUuidParam(req.params.wsId, 'workspace')
    requireUuidParam(req.params.episodeId, 'episode')
    const file = req.params.file
    if (!ARTIFACT_FILES.has(file)) {
      // 白名单外一律不存在（路径穿越面就此关闭），不区分形状错误
      throw new AppError('NOT_FOUND', 'media file not found', 404)
    }
    return send(reply, await prepareMediaPayload(
      mediaFilePath(app.mediaRoot, req.params.wsId, req.params.episodeId, 'artifacts', file),
      contentTypeFor(file),
      req.headers.range,
    ))
  })
}

/** 统一把 prepareMediaPayload 的结果套到 reply 上（唯一写 reply 处） */
function send(
  reply: { code(code: number): unknown; header(name: string, value: string): unknown },
  prepared: { statusCode: number; headers: Record<string, string>; payload: unknown },
) {
  reply.code(prepared.statusCode)
  for (const [name, value] of Object.entries(prepared.headers)) reply.header(name, value)
  return prepared.payload
}
