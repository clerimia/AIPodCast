// workspaces 模块路由（#19 表 1「工作间与单集」）。
// 校验（形状/音色）在路由层，约束（存在性/引用冲突）在服务层；错误统一走 app.ts 的
// setErrorHandler → { error: { code, message } }。
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../shared/errors.js'
import { asBody, optionalString, requireString, requireUuidParam } from '../../shared/validate.js'
import { isVoiceName } from '../../shared/voices.js'
import * as service from './service.js'

interface WsParams {
  wsId: string
}

interface SpeakerParams {
  wsId: string
  speakerId: string
}

function assertVoice(voice: string) {
  if (!isVoiceName(voice)) {
    throw new AppError('BAD_REQUEST', `'${voice}' is not one of the 24 system voices`, 400)
  }
}

export async function workspaceRoutes(app: FastifyInstance) {
  app.get('/', async () => service.listWorkspaces(app.db))

  app.post('/', async (req, reply) => {
    const body = asBody(req.body)
    const ws = await service.createWorkspace(app.db, { name: requireString(body, 'name') })
    return reply.status(201).send(ws)
  })

  app.get<{ Params: WsParams }>('/:wsId', async (req) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const ws = await service.getWorkspace(app.db, wsId)
    if (!ws) throw new AppError('NOT_FOUND', 'workspace not found', 404)
    return ws
  })

  // 更新节目元数据（大纲/主题/口吻/术语/禁词/节目简介）；字段缺省 = 不改
  app.put<{ Params: WsParams }>('/:wsId/show-metadata', async (req) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const body = asBody(req.body)
    const meta = await service.updateShowMetadata(app.db, wsId, {
      outline: optionalString(body, 'outline'),
      topic: optionalString(body, 'topic'),
      tone: optionalString(body, 'tone'),
      terms: optionalString(body, 'terms'),
      bannedWords: optionalString(body, 'bannedWords'),
      intro: optionalString(body, 'intro'),
    })
    if (!meta) throw new AppError('NOT_FOUND', 'workspace not found', 404)
    return meta
  })

  app.get<{ Params: WsParams }>('/:wsId/speakers', async (req) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const rows = await service.listSpeakers(app.db, wsId)
    if (rows === null) throw new AppError('NOT_FOUND', 'workspace not found', 404)
    return rows
  })

  app.post<{ Params: WsParams }>('/:wsId/speakers', async (req, reply) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const body = asBody(req.body)
    const voice = requireString(body, 'voice')
    assertVoice(voice)
    const speaker = await service.createSpeaker(app.db, wsId, {
      name: requireString(body, 'name'),
      persona: optionalString(body, 'persona'),
      gender: optionalString(body, 'gender'),
      voice,
    })
    if (!speaker) throw new AppError('NOT_FOUND', 'workspace not found', 404)
    return reply.status(201).send(speaker)
  })

  app.patch<{ Params: SpeakerParams }>('/:wsId/speakers/:speakerId', async (req) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const speakerId = requireUuidParam(req.params.speakerId, 'speaker')
    const body = asBody(req.body)
    const name = optionalString(body, 'name')
    if (name !== undefined && name.trim() === '') {
      throw new AppError('BAD_REQUEST', "field 'name' must be a non-empty string", 400)
    }
    const voice = optionalString(body, 'voice')
    if (voice !== undefined) assertVoice(voice)
    const speaker = await service.updateSpeaker(app.db, wsId, speakerId, {
      name,
      persona: optionalString(body, 'persona'),
      gender: optionalString(body, 'gender'),
      voice,
    })
    if (!speaker) throw new AppError('NOT_FOUND', 'speaker not found', 404)
    return speaker
  })

  // 删说话人；被 script_lines 引用时 409 CONFLICT（先改绑脚本行再删）
  app.delete<{ Params: SpeakerParams }>('/:wsId/speakers/:speakerId', async (req, reply) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const speakerId = requireUuidParam(req.params.speakerId, 'speaker')
    const result = await service.deleteSpeaker(app.db, wsId, speakerId)
    if (result === 'not_found') throw new AppError('NOT_FOUND', 'speaker not found', 404)
    if (result === 'referenced') {
      throw new AppError(
        'CONFLICT',
        'speaker is still referenced by script lines; rebind or delete those lines first',
        409,
      )
    }
    return reply.status(204).send()
  })

  app.get<{ Params: WsParams }>('/:wsId/episodes', async (req) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const rows = await service.listEpisodes(app.db, wsId)
    if (rows === null) throw new AppError('NOT_FOUND', 'workspace not found', 404)
    return rows
  })

  // 建单集：连带 conversations(kind=writer) 行 + post_rules 默认行（中/正常）
  app.post<{ Params: WsParams }>('/:wsId/episodes', async (req, reply) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const body = asBody(req.body)
    const ep = await service.createEpisode(app.db, wsId, { title: requireString(body, 'title') })
    if (!ep) throw new AppError('NOT_FOUND', 'workspace not found', 404)
    return reply.status(201).send(ep)
  })
}
