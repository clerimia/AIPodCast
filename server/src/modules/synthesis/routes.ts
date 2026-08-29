// synthesis 模块路由（#19「试听 / 整集合成 / 产物」表；M4 只落 preview，整集异步 M5）。
// 试听 = 单行合成（同步阻塞，秒级）：命中素材直接返回，未命中 TTS 后回填；
// {force:true} 强制重生成（ADR-0006）。TTS 失败按 SYNTH_FAILED 透传 {error}，不吞 5xx。
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../shared/errors.js'
import { asBody, requireUuidParam } from '../../shared/validate.js'
import * as service from './service.js'

interface LineParams {
  episodeId: string
  lineId: string
}

export async function synthesisRoutes(app: FastifyInstance) {
  app.post<{ Params: LineParams }>('/:episodeId/lines/:lineId/preview', async (req) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    const lineId = requireUuidParam(req.params.lineId, 'line')
    const body = req.body === undefined ? {} : asBody(req.body)
    if (body.force !== undefined && typeof body.force !== 'boolean') {
      throw new AppError('BAD_REQUEST', "field 'force' must be a boolean", 400)
    }

    const asset = await service.synthesizeLine(
      app.db,
      { mediaRoot: app.mediaRoot, tts: app.tts },
      { episodeId, lineId, force: body.force === true },
    )
    if (!asset) throw new AppError('NOT_FOUND', 'line not found', 404)
    return { asset }
  })
}
