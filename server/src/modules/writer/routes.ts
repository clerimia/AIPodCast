// writer 模块路由（#19「写稿大师会话（SSE）」表）：
// POST messages —— 请求即流：session.prompt + session.subscribe 事件翻译成浏览器
//   SSE 词汇（sse.ts），直到 done/error 才关流；运行中再发 → 409（前端运行中禁用输入）。
//   用户气泡由前端本地渲染（输入即知），不占事件词汇。
// POST abort —— 中止当前 run（幂等：无运行中会话也 200）。
// GET history —— 解析 session JSONL 回放历史气泡（change_set 等 display:false 不回放）。
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../shared/errors.js'
import { asBody, requireUuidParam } from '../../shared/validate.js'
import { parseWriterHistory } from './history.js'
import { getWriterConversationRow } from './session.js'
import { runWriterSession, type BrowserSseEvent } from './sse.js'

interface EpisodeParams {
  episodeId: string
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  // 禁中间层缓冲（本地无反代，防御性）
  'X-Accel-Buffering': 'no',
}

function sseFrame(event: BrowserSseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
}

export async function writerRoutes(app: FastifyInstance) {
  app.post<{ Params: EpisodeParams }>('/:episodeId/writer/messages', async (req, reply) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    const body = asBody(req.body)
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      throw new AppError('BAD_REQUEST', "field 'text' must be a non-empty string", 400)
    }
    const text = body.text.trim()

    const session = await app.writer.getOrCreate(episodeId)
    if (!session.isIdle) {
      throw new AppError('CONFLICT', 'writer session is busy', 409)
    }

    // 请求即流：先开 SSE 通道，再 subscribe → prompt（事件在 prompt 期间同步发出）
    reply.raw.writeHead(200, SSE_HEADERS)
    reply.raw.flushHeaders()
    let open = true
    const write = (event: BrowserSseEvent) => {
      if (open) reply.raw.write(sseFrame(event))
    }
    const close = () => {
      open = false
      reply.raw.end()
    }
    // 客户端中途断开：停止写流；run 继续在服务端跑完（历史仍完整）。
    // 监听 reply.raw（ServerResponse）而非 req.raw——后者在 POST 请求体读毕即可能触发。
    reply.raw.on('close', close)

    let ended: 'done' | 'error' | null = null
    runWriterSession(session, write, (end) => {
      ended = end
      close()
    })

    try {
      await session.prompt(text)
    } catch (err) {
      write({ event: 'error', data: { message: err instanceof Error ? err.message : String(err) } })
      close()
      return reply
    }
    // prompt 正常返回但 onDone 未触发（异常路径兜底）：补关流
    if (ended === null) {
      write({ event: 'error', data: { message: 'writer run ended unexpectedly' } })
      close()
    }
    return reply
  })

  app.post<{ Params: EpisodeParams }>('/:episodeId/writer/abort', async (req) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    const aborted = await app.writer.abort(episodeId)
    return { aborted }
  })

  app.get<{ Params: EpisodeParams }>('/:episodeId/writer/history', async (req) => {
    const episodeId = requireUuidParam(req.params.episodeId, 'episode')
    // 懒建会话只为拿路径不值：直接读 conversations.session_file
    const row = await getWriterConversationRow(app.db, episodeId)
    return { messages: parseWriterHistory(row?.sessionFile) }
  })
}
