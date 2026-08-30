// writer 端点函数（#19「写稿大师会话（SSE）」表）：history/abort 走普通 JSON（http.ts）；
// messages 是 POST 请求即 SSE 流，fetch + ReadableStream 手解（sse.ts），不走 http.ts。
import type { WriterAbortResponse, WriterHistory, WriterSseEvent } from './types'
import { createSseParser } from '../sse'
import { ApiError, http } from './http'

export const writerApi = {
  getHistory: (episodeId: string) => http.get<WriterHistory>(`/episodes/${episodeId}/writer/history`),

  abort: (episodeId: string) => http.post<WriterAbortResponse>(`/episodes/${episodeId}/writer/abort`),

  /**
   * 发消息并逐帧回调浏览器事件词汇；流以 done/error 结束（或被 abort）。
   * thinking（ADR-0010 思考开关）：true 下发 thinking:true（默认关不下发，请求体保持现状）。
   * 抛错 = 请求/流层失败（网络断、409 busy、5xx），SSE `error` 事件不抛错、走 onEvent。
   */
  async sendMessage(
    episodeId: string,
    text: string,
    thinking: boolean,
    onEvent: (event: WriterSseEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`/api/episodes/${episodeId}/writer/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(thinking && { thinking: true }) }),
      signal,
    })
    if (!res.ok || !res.body) {
      let code = String(res.status)
      let message = res.statusText
      try {
        const payload = (await res.json()) as { error?: { code?: string; message?: string } }
        if (payload.error) {
          code = payload.error.code ?? code
          message = payload.error.message ?? message
        }
      } catch {
        // 非 JSON 错误体，保持默认
      }
      throw new ApiError(code, message, res.status)
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    const parse = createSseParser((frame) => {
      // 未知事件名忽略（前后端独立演进）；data 是单行 JSON
      let data: unknown = {}
      try {
        data = JSON.parse(frame.data)
      } catch {
        // 空/坏 data 按 {} 处理
      }
      onEvent({ event: frame.event, data } as WriterSseEvent)
    })
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parse(value)
    }
  },
}
