// resources 模块路由（知识摄入与检索设计 2026-08-31）。
// 校验（形状/上限）在路由层，约束（工作间存在性/事务）在服务层；错误统一走
// app.ts 的 setErrorHandler → { error: { code, message } }。
// POST 摄入双形态：multipart 文件（字段 file）或 JSON { title, text }（粘贴）。
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '../../shared/errors.js'
import { asBody, optionalString, requireString, requireUuidParam } from '../../shared/validate.js'
import { convertToMarkdown, MAX_FILE_BYTES, MAX_PASTE_CHARS, type ResourceKind } from './convert.js'
import * as service from './service.js'

interface WsParams {
  wsId: string
}

interface ResourceParams {
  wsId: string
  rid: string
}

interface ParsedIngest {
  title: string | undefined
  kind: ResourceKind
  contentMd: string
}

/** 摄入/替换共用的请求解析：multipart（字段 file）或 JSON { title, text }（粘贴）。
 *  标题统一 trim 后返回（粘贴缺省 undefined=沿用原标题/必填校验由调用方决定）。 */
async function parseIngest(req: FastifyRequest, opts: { titleRequired?: boolean } = {}): Promise<ParsedIngest> {
  if (req.isMultipart()) {
    const file = await req.file({ limits: { fileSize: MAX_FILE_BYTES } })
    if (!file) throw new AppError('BAD_REQUEST', '缺少上传文件（字段名 file）', 400)
    if (file.file.truncated) {
      // 丢弃未读部分，避免超限后连接残留未消费 body（无法复用）
      file.file.resume()
      throw new AppError('BAD_REQUEST', `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`, 400)
    }
    const buffer = await file.toBuffer()
    const { kind, markdown } = await convertToMarkdown(buffer, file.filename)
    const title = file.filename.replace(/\.[^.]+$/, '').trim() || file.filename
    return { title, kind, contentMd: markdown }
  }
  const body = asBody(req.body)
  const text = requireString(body, 'text')
  if (text.length > MAX_PASTE_CHARS) {
    throw new AppError('BAD_REQUEST', `粘贴文本超过 ${MAX_PASTE_CHARS} 字符上限`, 400)
  }
  const title = optionalString(body, 'title')
  if (title === undefined) {
    if (opts.titleRequired) throw new AppError('BAD_REQUEST', "field 'title' must be a non-empty string", 400)
    return { title: undefined, kind: 'paste', contentMd: text }
  }
  if (title.trim() === '') throw new AppError('BAD_REQUEST', "field 'title' must be a non-empty string", 400)
  return { title: title.trim(), kind: 'paste', contentMd: text }
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

  // 摄入：multipart（字段 file）或 JSON { title, text }（粘贴）
  app.post<{ Params: WsParams }>('/:wsId/resources', async (req, reply) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const parsed = await parseIngest(req, { titleRequired: true })
    const result = await service.ingestResource(app.db, wsId, {
      title: parsed.title!,
      kind: parsed.kind,
      contentMd: parsed.contentMd,
    }, { embedder: app.embedder })
    if (!result) throw new AppError('NOT_FOUND', 'workspace not found', 404)
    return reply.status(201).send(result)
  })

  // 显式替换：同摄入管道；事务内删旧块 + 写新块，中途失败整体回滚
  app.post<{ Params: ResourceParams }>('/:wsId/resources/:rid/replace', async (req) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const rid = requireUuidParam(req.params.rid, 'resource')
    const parsed = await parseIngest(req)
    const result = await service.replaceResource(app.db, wsId, rid, {
      title: parsed.title,
      kind: parsed.kind,
      contentMd: parsed.contentMd,
    }, { embedder: app.embedder })
    if (result === 'not_found') throw new AppError('NOT_FOUND', 'resource not found', 404)
    return result
  })

  app.delete<{ Params: ResourceParams }>('/:wsId/resources/:rid', async (req, reply) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const rid = requireUuidParam(req.params.rid, 'resource')
    const deleted = await service.deleteResource(app.db, wsId, rid)
    if (!deleted) throw new AppError('NOT_FOUND', 'resource not found', 404)
    return reply.status(204).send()
  })

  // 显式向量化：用户在前端"向量化"按钮触发。同步等结果：toast 成功 / 部分失败 / 全失败。
  app.post<{ Params: ResourceParams }>('/:wsId/resources/:rid/embed', async (req) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const rid = requireUuidParam(req.params.rid, 'resource')
    const result = await service.embedResource(app.db, wsId, rid, { embedder: app.embedder })
    if (result === 'not_found') throw new AppError('NOT_FOUND', 'resource not found', 404)
    return result
  })
}
