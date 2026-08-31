// resources 模块路由（知识摄入与检索设计 2026-08-31）。
// 校验（形状/上限）在路由层，约束（工作间存在性/事务）在服务层；错误统一走
// app.ts 的 setErrorHandler → { error: { code, message } }。
// 本任务落列表/详情/删除骨架；摄入/替换路由在 Task 9 追加。
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../shared/errors.js'
import { requireUuidParam } from '../../shared/validate.js'
import * as service from './service.js'

interface WsParams {
  wsId: string
}

interface ResourceParams {
  wsId: string
  rid: string
}

export async function resourceRoutes(app: FastifyInstance) {
  app.get<{ Params: WsParams }>('/:wsId/resources', async (req) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const rows = await service.listResources(app.db, wsId)
    if (rows === null) throw new AppError('NOT_FOUND', 'workspace not found', 404)
    return rows
  })

  app.get<{ Params: ResourceParams }>('/:wsId/resources/:rid', async (req) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const rid = requireUuidParam(req.params.rid, 'resource')
    const detail = await service.getResource(app.db, wsId, rid)
    if (!detail) throw new AppError('NOT_FOUND', 'resource not found', 404)
    return detail
  })

  app.delete<{ Params: ResourceParams }>('/:wsId/resources/:rid', async (req, reply) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const rid = requireUuidParam(req.params.rid, 'resource')
    const deleted = await service.deleteResource(app.db, wsId, rid)
    if (!deleted) throw new AppError('NOT_FOUND', 'resource not found', 404)
    return reply.status(204).send()
  })
}
