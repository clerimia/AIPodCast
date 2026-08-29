// synthesis 模块路由（#19「试听 / 整集合成 / 产物」表）：
// - preview：单行合成（同步阻塞，秒级）：命中素材直接返回，未命中 TTS 后回填；{force:true}
//   强制重生成（ADR-0006）。整集合成 TTS 阶段行级互斥（#28 定案）：该行在快照 plan 内且
//   未完成 → 409 该行合成中。
// - synthesize：整集合成（异步，分钟级）→ 202 {jobId, statusUrl}；编排落 synthesis_jobs
//   表（#28 定案），进程内 async 循环跑 ADR-0007 全量管线，验证失败保留旧产物。
// TTS 失败按 {error} 透传，不吞 5xx。
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../shared/errors.js'
import { asBody, requireUuidParam } from '../../shared/validate.js'
import * as service from './service.js'

interface LineParams {
  episodeId: string
  lineId: string
}

interface EpisodeParams {
  episodeId: string
}

export async function synthesisRoutes(app: FastifyInstance) {
  app.post<{ Params: LineParams }>('/:episodeId/lines/:lineId/preview', async (req) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    const lineId = requireUuidParam(req.params.lineId, 'line')
    const body = req.body === undefined ? {} : asBody(req.body)
    if (body.force !== undefined && typeof body.force !== 'boolean') {
      throw new AppError('BAD_REQUEST', "field 'force' must be a boolean", 400)
    }

    if (await app.jobs.isLineLocked(episodeId, lineId)) {
      throw new AppError('CONFLICT', '该行正在整集合成中，稍后再试听', 409)
    }
    const asset = await service.synthesizeLine(
      app.db,
      { mediaRoot: app.mediaRoot, tts: app.tts },
      { episodeId, lineId, force: body.force === true },
    )
    if (!asset) throw new AppError('NOT_FOUND', 'line not found', 404)
    return { asset }
  })

  // 整集合成（异步）：202 任务句柄，前端轮询 GET /api/synthesis-jobs/:jobId
  app.post<{ Params: EpisodeParams }>('/:episodeId/synthesize', async (req, reply) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    const { jobId } = await app.jobs.start(episodeId)
    reply.code(202)
    return { jobId, statusUrl: `/api/synthesis-jobs/${jobId}` }
  })
}

/** 任务轮询（#19 最小形状 + #22 超集载荷；M6 加 cancel/active-job 端点） */
export async function synthesisJobRoutes(app: FastifyInstance) {
  app.get<{ Params: { jobId: string } }>('/:jobId', async (req) => {
    const jobId = requireUuidParam(req.params.jobId, 'job')
    const job = await app.jobs.get(jobId)
    if (!job) throw new AppError('NOT_FOUND', 'synthesis job not found', 404)
    return job
  })
}
