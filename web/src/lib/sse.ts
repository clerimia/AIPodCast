// SSE 帧解析（frontend-structure.md「SSE」）：fetch + ReadableStream 手解帧，
// POST 请求即流（EventSource 不支持 POST，#19 已定）。
// 只解析本应用用到的子集：`event:` + `data:`（服务端单行 JSON）；retry:/注释行忽略。

export interface SseFrame {
  event: string
  data: string
}

/**
 * 逐块解析 SSE 字节流：跨 chunk 的行缓冲，每个完整帧（空行收尾）回调一次。
 * 状态在闭包内，可安全并发创建多个解析器。
 */
export function createSseParser(onFrame: (frame: SseFrame) => void): (chunk: string) => void {
  let buffer = ''
  let event = ''
  const data: string[] = []

  const dispatch = () => {
    if (event !== '' || data.length > 0) {
      onFrame({ event, data: data.join('\n') })
    }
    event = ''
    data.length = 0
  }

  return (chunk) => {
    buffer += chunk
    let sep: number
    while ((sep = buffer.indexOf('\n')) !== -1) {
      const rawLine = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 1)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).trimStart())
      } else if (line === '') {
        dispatch()
      }
      // 其他行（retry:/注释/未知字段）忽略
    }
  }
}
