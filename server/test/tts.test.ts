import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeDashscopeTts, TTS_MODEL } from '../src/modules/synthesis/tts.js'
import { AppError } from '../src/shared/errors.js'

// tts 客户端单测：注入 fetchImpl + 凭证，不打真网（真端点连通性见 scripts/spike-tts.ts）。
// 请求形态与错误语义对齐 docs/research/qwen3-tts-instruct-flash.md（#19 验证项 2）。

const BASE = 'https://dashscope.test'
const OPTS = { apiKey: 'test-key', baseUrl: BASE }

/** 一次 fake 网络会话：generation 响应每请求新建（Response 体只读一次），oss 下载 URL 返回固定字节 */
function fakeNet(makeGenerationResponse: () => Response, audioBytes = Buffer.alloc(8)) {
  const generationCalls: { url: string; init: RequestInit }[] = []
  const impl: typeof fetch = async (url, init) => {
    const record = { url: String(url), init: init ?? {} }
    if (record.url.includes('oss.example')) return new Response(new Uint8Array(audioBytes))
    generationCalls.push(record)
    return makeGenerationResponse()
  }
  return { impl, generationCalls }
}

test('请求体：model + input{text, voice, language_type}，Bearer 鉴权；instructions 空不下发、有则下发', async () => {
  const { impl, generationCalls } = fakeNet(() => Response.json({ output: { audio: { url: "https://oss.example/a.wav" } } }))
  const tts = makeDashscopeTts({ ...OPTS, fetchImpl: impl })

  await tts.synthesize({ text: '你好', voice: 'Cherry', instructions: '' })

  assert.equal(generationCalls.length, 1)
  const { url, init } = generationCalls[0]!
  assert.equal(url, `${BASE}/api/v1/services/aigc/multimodal-generation/generation`)
  assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-key')
  assert.deepEqual(JSON.parse(String(init.body)), {
    model: TTS_MODEL,
    input: { text: '你好', voice: 'Cherry', language_type: 'Auto' },
  })

  await tts.synthesize({ text: '你好', voice: 'Ethan', instructions: '用开心的语气说' })
  assert.deepEqual(
    (JSON.parse(String(generationCalls[1]!.init.body)) as { input: Record<string, unknown> }).input.instructions,
    '用开心的语气说',
  )
})

test('成功：下载 audio.url 字节并返回 Buffer', async () => {
  const wav = Buffer.from('RIFF0000WAVEfmt')
  const { impl } = fakeNet(() => Response.json({ output: { audio: { url: 'https://oss.example/a.wav' } } }), wav)
  const bytes = await makeDashscopeTts({ ...OPTS, fetchImpl: impl }).synthesize({ text: 'x', voice: 'Cherry' })
  assert.deepEqual(bytes, wav)
})

test('上游非 2xx：SYNTH_FAILED(502) 带上游 code/message', async () => {
  const { impl } = fakeNet(() => Response.json({ code: "InvalidApiKey", message: "Invalid API-key provided." }, { status: 401 }))
  await assert.rejects(
    makeDashscopeTts({ ...OPTS, fetchImpl: impl }).synthesize({ text: 'x', voice: 'Cherry' }),
    (err: unknown) =>
      err instanceof AppError && err.code === 'SYNTH_FAILED' && err.statusCode === 502 && /InvalidApiKey/.test(err.message),
  )
})

test('缺 audio.url / 下载失败 / 网络异常 → SYNTH_FAILED(502)', async () => {
  const noUrl = fakeNet(() => Response.json({ output: {} }))
  await assert.rejects(
    makeDashscopeTts({ ...OPTS, fetchImpl: noUrl.impl }).synthesize({ text: 'x', voice: 'Cherry' }),
    (err: unknown) => err instanceof AppError && err.code === 'SYNTH_FAILED',
  )

  const badDownload = fakeNet(() => Response.json({ output: { audio: { url: 'https://oss.example/a.wav' } } }), Buffer.alloc(0))
  badDownload.impl = (async (url: string | URL | Request) =>
    String(url).includes('oss.example') ? new Response('', { status: 403 }) : Response.json({ output: { audio: { url: 'https://oss.example/a.wav' } } })) as typeof fetch
  await assert.rejects(
    makeDashscopeTts({ ...OPTS, fetchImpl: badDownload.impl }).synthesize({ text: 'x', voice: 'Cherry' }),
    (err: unknown) => err instanceof AppError && err.code === 'SYNTH_FAILED',
  )

  const networkError: typeof fetch = async () => {
    throw new Error('connect ECONNREFUSED')
  }
  await assert.rejects(
    makeDashscopeTts({ ...OPTS, fetchImpl: networkError }).synthesize({ text: 'x', voice: 'Cherry' }),
    (err: unknown) => err instanceof AppError && err.code === 'SYNTH_FAILED' && /ECONNREFUSED/.test(err.message),
  )
})

test('缺 API key：INTERNAL(500) 提示配置缺失', async () => {
  const { impl } = fakeNet(() => Response.json({}))
  await assert.rejects(
    makeDashscopeTts({ fetchImpl: impl, apiKey: null, baseUrl: BASE }).synthesize({ text: 'x', voice: 'Cherry' }),
    (err: unknown) => err instanceof AppError && err.code === 'INTERNAL' && err.statusCode === 500,
  )
})
