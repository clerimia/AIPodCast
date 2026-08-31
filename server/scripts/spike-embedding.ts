// Spike 2：DashScope text-embedding-v4 compatible-mode 端点：请求形状、维度、批量上限。
// 用法：npm run spike-embedding -w server（凭证从 server/.env / 仓库根 .env 加载）
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
loadEnv({ path: join(serverDir, '.env') })
loadEnv({ path: join(serverDir, '../.env') })

const apiKey = process.env.DASHSCOPE_API_KEY
if (!apiKey) throw new Error('missing DASHSCOPE_API_KEY')
const base = (process.env.DASHSCOPE_BASE_URL ?? 'https://dashscope.aliyuncs.com').replace(/\/+$/, '')
const url = `${base}/compatible-mode/v1/embeddings`

async function embed(inputs: string[]) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-v4', input: inputs, dimensions: 1024 }),
  })
  const payload = (await res.json()) as {
    data?: { embedding: number[]; index: number }[]
    error?: { code?: string; message?: string }
  }
  return { status: res.status, payload }
}

// 验证项 1：两条文本 + dimensions=1024 被接受
const two = await embed(['你好，世界', '量子计算的纠错码'])
console.log('批量 2：', two.status, '维度：', two.payload.data?.map((d) => d.embedding.length))
if ((two.status === 401 || two.status === 403) && two.payload.error?.code) {
  // 账户级拒绝（配额/欠费/无权限）：端点形状已可达，数值验证项降级记录
  console.log(
    'SPIKE DEGRADED：端点可达但账户级拒绝——',
    two.status,
    JSON.stringify(two.payload.error).slice(0, 300),
  )
  console.log('结论写入 docs/research/knowledge-retrieval-spikes.md：维度/批量上限待配额恢复后复测')
  process.exit(0)
}
if (two.status !== 200 || two.payload.data?.length !== 2 || two.payload.data[0]?.embedding.length !== 1024) {
  throw new Error('批量 2 / 1024 维未按预期：' + JSON.stringify(two.payload.error ?? two.status))
}

// 验证项 2：单次批量上限（官方限额 10；探 10 与 11）
const ten = await embed(Array.from({ length: 10 }, (_, i) => `文本 ${i}`))
console.log('批量 10：', ten.status)
const eleven = await embed(Array.from({ length: 11 }, (_, i) => `文本 ${i}`))
console.log('批量 11：', eleven.status, JSON.stringify(eleven.payload.error ?? 'ok').slice(0, 200))

console.log('SPIKE OK：把批量上限与错误码结论写入 docs/research/knowledge-retrieval-spikes.md')
