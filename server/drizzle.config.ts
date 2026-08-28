import { defineConfig } from 'drizzle-kit'
import { env } from './src/env.js'

// env 复用 src/env.ts 的加载（优先级 process env > server/.env > 仓库根 .env）
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: {
    url: env.databaseUrl,
  },
})
