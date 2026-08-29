import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { artifactsRoutes } from './modules/artifacts/routes.js'
import { createDb, type Db } from './db/client.js'
import { healthRoutes } from './modules/health/routes.js'
import { scriptRoutes } from './modules/script/routes.js'
import { synthesisRoutes } from './modules/synthesis/routes.js'
import { makeDashscopeTts, type TtsClient } from './modules/synthesis/tts.js'
import { writerRoutes } from './modules/writer/routes.js'
import { WriterRuntime } from './modules/writer/session.js'
import { workspaceRoutes } from './modules/workspaces/routes.js'
import { AppError, type ErrorPayload } from './shared/errors.js'
import { env } from './env.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Db
    writer: WriterRuntime
    mediaRoot: string
    tts: TtsClient
  }
}

export interface BuildAppOptions {
  /** 覆盖 DATABASE_URL（测试/多实例用） */
  databaseUrl?: string
  /** 覆盖 MEDIA_ROOT（测试隔离临时目录用） */
  mediaRoot?: string
  /** 覆盖 TTS 客户端（测试注入 stub 用） */
  tts?: TtsClient
}

// Fastify 组装：插件、路由注册、统一错误形状（M4 起在此加 media 静态服务）
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  })

  const db = createDb(opts.databaseUrl ?? env.databaseUrl)
  app.decorate('db', db)

  // 媒体根（素材/产物落盘与流式共用）；TTS 客户端（synthesis 用，测试可注 stub）
  app.decorate('mediaRoot', opts.mediaRoot ?? env.mediaRoot)
  app.decorate('tts', opts.tts ?? makeDashscopeTts())

  // 写稿运行时（Map<episodeId, AgentSession>）；进程退出统一 dispose（ADR-0005/配方 §3.3）
  const writer = new WriterRuntime(db)
  app.decorate('writer', writer)
  app.addHook('onClose', async () => {
    await writer.dispose()
    await db.$client.end({ timeout: 1 })
  })

  app.setNotFoundHandler((req, reply) => {
    const payload: ErrorPayload = {
      error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` },
    }
    reply.status(404).send(payload)
  })

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) {
      const payload: ErrorPayload = { error: { code: err.code, message: err.message } }
      reply.status(err.statusCode).send(payload)
      return
    }
    if (err.validation) {
      const payload: ErrorPayload = {
        error: { code: 'BAD_REQUEST', message: err.message },
      }
      reply.status(400).send(payload)
      return
    }
    req.log.error(err)
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500
    const payload: ErrorPayload = {
      // 非 AppError 的 4xx（如请求体 JSON 解析失败）按 BAD_REQUEST 报告
      error: { code: status === 400 ? 'BAD_REQUEST' : 'INTERNAL', message: err.message },
    }
    reply.status(status).send(payload)
  })

  await app.register(healthRoutes, { prefix: '/api' })
  await app.register(workspaceRoutes, { prefix: '/api/workspaces' })
  await app.register(scriptRoutes, { prefix: '/api/episodes' })
  await app.register(synthesisRoutes, { prefix: '/api/episodes' })
  await app.register(writerRoutes, { prefix: '/api/episodes' })
  await app.register(artifactsRoutes, { prefix: '/api' })

  return app
}
