// #27 M4 spike：DashScope qwen3-tts-instruct-flash 真端点连通性（M4 第一件事「先最小调通」）。
// 验证项（docs/research/qwen3-tts-instruct-flash.md 对齐）：请求体 input 四字段被接受；
// 响应含 output.audio.url；下载的字节是 RIFF/WAVE（wav 24k mono 16-bit）；
// wavDurationMs 解析出合理时长。产物落 tmp/ 供人工试听。
// 用法：npm run spike-tts -w server（凭证从 server/.env / 仓库根 .env 加载）
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { makeDashscopeTts } from '../src/modules/synthesis/tts.js'
import { wavDurationMs } from '../src/modules/synthesis/wav.js'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
loadEnv({ path: join(serverDir, '.env') })
loadEnv({ path: join(serverDir, '../.env') })

if (!process.env.DASHSCOPE_API_KEY) throw new Error('missing DASHSCOPE_API_KEY')

const tts = makeDashscopeTts()
const bytes = await tts.synthesize({
  text: '欢迎收听本期节目，我们一起聊聊音频工作间的第一天。',
  voice: 'Cherry',
  instructions: '用轻松愉快的语气说',
})

const magic = bytes.subarray(0, 4).toString('ascii')
const wave = bytes.subarray(8, 12).toString('ascii')
const durationMs = wavDurationMs(bytes)
console.log('bytes:', bytes.length)
console.log('RIFF/WAVE:', magic === 'RIFF' && wave === 'WAVE')
console.log('durationMs:', durationMs)

if (magic !== 'RIFF' || wave !== 'WAVE' || durationMs === null) {
  throw new Error('unexpected audio payload: not a parseable RIFF/WAVE file')
}

const outDir = join(serverDir, '../tmp/spike-tts')
await mkdir(outDir, { recursive: true })
const out = join(outDir, `probe-${Date.now()}.wav`)
await writeFile(out, bytes)
console.log('saved:', out, '→ 人工试听确认音色/语气/语速')
