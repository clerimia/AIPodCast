// DashScope qwen3-tts-instruct-flash 最小客户端（#27 M4；能力边界见
// docs/research/qwen3-tts-instruct-flash.md）：原生 multimodal-generation 端点，
// 请求体只有 model + input{text, voice, language_type, instructions}，无任何音频参数；
// 非流式响应 = output.audio.url（wav 24k mono 16-bit，24h 有效）→ 立即下载字节落盘。
// 错误语义（#19 验证项 3/4）：缺 key → INTERNAL；请求/下载失败、上游非 2xx、缺 url
// 一律 SYNTH_FAILED（502，带上游 code/message），路由层不吞成裸 5xx。超时/重试 M6 补全。
import { AppError } from '../../shared/errors.js'
import { env } from '../../env.js'

export const TTS_MODEL = 'qwen3-tts-instruct-flash'
const TTS_TIMEOUT_MS = 30_000

export interface TtsInput {
  text: string
  /** 24 系统音色名之一（speaker.voice） */
  voice: string
  /** 自然语言"怎么说"；空串不下发（文档：默认不设不生效） */
  instructions?: string
}

export interface TtsClient {
  /** signal：请求级中止（#22 取消 / preview 超时共用管道）；与 30s 超时取先到 */
  synthesize(input: TtsInput, signal?: AbortSignal): Promise<Buffer>
}

interface DashscopeTtsResponse {
  output?: { audio?: { url?: string } }
  code?: string
  message?: string
}

export interface DashscopeTtsOptions {
  fetchImpl?: typeof fetch
  /** 缺省读 env.dashscopeApiKey；显式传 null = 无凭证（测试缺失分支用） */
  apiKey?: string | null
  /** 缺省读 env.dashscopeBaseUrl，再缺省官方主机 */
  baseUrl?: string | null
}

export function makeDashscopeTts(options: DashscopeTtsOptions = {}): TtsClient {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    async synthesize(input: TtsInput, signal?: AbortSignal): Promise<Buffer> {
      const apiKey = options.apiKey !== undefined ? options.apiKey : env.dashscopeApiKey
      if (!apiKey) {
        throw new AppError('INTERNAL', 'DASHSCOPE_API_KEY 未配置，TTS 不可用', 500)
      }
      // BASE_URL 只填主机（与写稿共用）；TTS 拼原生端点，不拼 /compatible-mode/v1
      const base = (options.baseUrl ?? env.dashscopeBaseUrl ?? 'https://dashscope.aliyuncs.com').replace(/\/+$/, '')

      // 外部 signal（取消/超时）与 30s 兜底超时竞速，先到者中止
      const requestInit: RequestInit = {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: TTS_MODEL,
          input: {
            text: input.text,
            voice: input.voice,
            language_type: 'Auto',
            ...(input.instructions ? { instructions: input.instructions } : {}),
          },
        }),
        signal: AbortSignal.any([AbortSignal.timeout(TTS_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      }

      let res: Response
      try {
        res = await fetchImpl(`${base}/api/v1/services/aigc/multimodal-generation/generation`, requestInit)
      } catch (err) {
        throw new AppError('SYNTH_FAILED', `TTS 请求失败：${errMessage(err)}`, 502)
      }
      const payload = (await res.json().catch(() => null)) as DashscopeTtsResponse | null
      if (!res.ok) {
        // M4 契约：路由层一律 SYNTH_FAILED 502；upstreamStatus 保留上游真实状态码，
        // 供任务层重试判定（synthesis-progress-and-cancel.md：4xx 参数错误不重试）
        const err = new AppError(
          'SYNTH_FAILED',
          `TTS 上游错误 ${payload?.code ?? res.status}：${payload?.message ?? res.statusText}`,
          502,
        )
        Object.assign(err, { upstreamStatus: res.status })
        throw err
      }
      const url = payload?.output?.audio?.url
      if (!url) throw new AppError('SYNTH_FAILED', 'TTS 响应缺少 output.audio.url', 502)

      let audio: Response
      try {
        audio = await fetchImpl(url, {
          signal: AbortSignal.any([AbortSignal.timeout(TTS_TIMEOUT_MS), ...(signal ? [signal] : [])]),
        })
      } catch (err) {
        throw new AppError('SYNTH_FAILED', `TTS 音频下载失败：${errMessage(err)}`, 502)
      }
      if (!audio.ok) {
        throw new AppError('SYNTH_FAILED', `TTS 音频下载失败：HTTP ${audio.status}`, 502)
      }
      return Buffer.from(await audio.arrayBuffer())
    },
  }
}

function errMessage(err: unknown): string {
  // AbortSignal.timeout 超时以 TimeoutError 抛出（DOMException）， message 已可读
  return err instanceof Error ? err.message : String(err)
}
