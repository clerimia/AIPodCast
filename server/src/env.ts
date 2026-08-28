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

export const env = {
  port: intEnv('PORT', 3000),
  // 缺省即 docker-compose.yml 的 Postgres 17 凭据
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/aipodcast',
  mediaRoot: mediaRootEnv(),
  // M3 写稿 / M4 TTS 才消费；M0 只透传
  dashscopeApiKey: process.env.DASHSCOPE_API_KEY ?? null,
  dashscopeBaseUrl: process.env.DASHSCOPE_BASE_URL ?? null,
} as const
