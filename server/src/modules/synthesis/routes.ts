// synthesis 模块路由（#19「试听 / 整集合成 / 产物」表）：
// - preview：单行合成（同步阻塞，秒级）：命中素材直接返回，未命中 TTS 后回填；{force:true}
//   强制重生成（ADR-0006）。整集合成 TTS 阶段行级互斥（#28 定案）：该行在快照 plan 内且
//   未完成 → 409 该行合成中。请求级 90s 超时（#19 验证项 3；Fastify 无路由级 requestTimeout，
//   勿动 server 级——会伤 SSE）。TTS 失败按 {error} 透传，不吞 5xx。
// - synthesize：整集合成（异步，分钟级）→ 202 {jobId, statusUrl}；编排落 synthesis_jobs
//   表（#28 定案），进程内 async 循环跑 ADR-0007 全量管线，验证失败保留旧产物。
// - synthesis-job/:jobId/cancel 与 episodes/:id/synthesis-job 端点契约见
//   docs/synthesis-progress-and-cancel.md（#22 / M6）。
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../shared/errors.js'
import { asBody, requireUuidParam } from '../../shared/validate.js'
import { ACTIVE_STATUSES } from './jobs.js'
import * as service from './service.js'

interface LineParams {
  episodeId: string
  lineId: string
}

interface EpisodeParams {
  episodeId: string
}

/** preview 请求级超时（#19 验证项 3）：命中素材瞬回，未命中 TTS 上限 90s */
const PREVIEW_TIMEOUT_MS = 90_000

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
      { episodeId, lineId, force: body.force === true, signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS) },
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

  // 活跃任务快照（#22）：pending/running/canceling 之一 → 200；最近一次 interrupted → 200
  //（前端「上次合成被中断」横幅）；都没有 → 404。api-and-dataflow.md L148 口径。
  app.get<{ Params: EpisodeParams }>('/:episodeId/synthesis-job', async (req) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    const job = await app.jobs.getActive(episodeId)
    if (!job) throw new AppError('NOT_FOUND', 'no synthesis job for episode', 404)
    return job
  })
}

/** 任务轮询（#19 最小形状 + #22 超集载荷）+ 取消端点（两段式 canceling → canceled） */
export async function synthesisJobRoutes(app: FastifyInstance) {
  app.get<{ Params: { jobId: string } }>('/:jobId', async (req) => {
    const jobId = requireUuidParam(req.params.jobId, 'job')
    const job = await app.jobs.get(jobId)
    if (!job) throw new AppError('NOT_FOUND', 'synthesis job not found', 404)
    return job
  })

  // 取消（#22）：pending/running → 202（status=canceling）；已在 canceling → 200 幂等快照；
  // 终态 → 409；未知 → 404
  app.post<{ Params: { jobId: string } }>('/:jobId/cancel', async (req, reply) => {
    const jobId = requireUuidParam(req.params.jobId, 'job')
    const job = await app.jobs.get(jobId)
    if (!job) throw new AppError('NOT_FOUND', 'synthesis job not found', 404)
    if (!ACTIVE_STATUSES.includes(job.status)) {
      throw new AppError('CONFLICT', '任务已结束，无法取消', 409)
    }
    const snapshot = await app.jobs.requestCancel(jobId)
    reply.code(job.status === 'canceling' ? 200 : 202)
    return snapshot
  })
}
