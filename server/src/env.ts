import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

// dotenv 不覆盖已设值 → 优先级：process env > server/.env > 仓库根 .env
loadEnv({ path: join(serverDir, '.env') })
loadEnv({ path: join(repoRoot, '.env') })

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) throw new Error(`env ${name} must be an integer, got: ${raw}`)
  return parsed
}

// MEDIA_ROOT 相对路径一律相对仓库根解析（与 .env.example 的 ./media 语义一致）
function mediaRootEnv(): string {
  const raw = process.env.MEDIA_ROOT
  if (raw === undefined || raw === '') return join(repoRoot, 'media')
  return isAbsolute(raw) ? resolve(raw) : join(repoRoot, raw)
}

// 写稿会话 JSONL 目录（SessionManager sessionDir）；相对路径同 MEDIA_ROOT 语义
function sessionsDirEnv(): string {
  const raw = process.env.SESSIONS_DIR
  if (raw === undefined || raw === '') return join(repoRoot, 'data', 'sessions')
  return isAbsolute(raw) ? resolve(raw) : join(repoRoot, raw)
}

// PI SDK 的 agentDir 落点（auth.json 凭证 / packageManager），指向应用自己的目录，避开 ~/.pi/agent
function agentDirEnv(): string {
  const raw = process.env.PI_AGENT_DIR
  if (raw === undefined || raw === '') return join(repoRoot, 'data', 'agent')
  return isAbsolute(raw) ? resolve(raw) : join(repoRoot, raw)
}

export const env = {
  port: intEnv('PORT', 3000),
  // 缺省即 docker-compose.yml 的 Postgres 17 凭据
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/aipodcast',
  mediaRoot: mediaRootEnv(),
  // 写稿会话 JSONL 目录（一集一个文件，conversations.session_file 存绝对路径）
  sessionsDir: sessionsDirEnv(),
  // PI SDK agentDir（凭证/包管理落点；不指向 ~/.pi/agent）
  agentDir: agentDirEnv(),
  // 写稿 LLM（DashScope OpenAI 兼容端点）；模型 id 可按端点调整
  dashscopeApiKey: process.env.DASHSCOPE_API_KEY ?? null,
  dashscopeBaseUrl: process.env.DASHSCOPE_BASE_URL ?? null,
  writerModel: process.env.WRITER_MODEL ?? 'qwen3.7-plus',
} as const
