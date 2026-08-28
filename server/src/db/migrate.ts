// 迁移脚本：npm run migrate -w server（cwd = server/）
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { env } from '../env.js'

const sql = postgres(env.databaseUrl, { max: 1 })
const db = drizzle(sql, { casing: 'snake_case' })

try {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
  })
  console.log(`[migrate] done: ${env.databaseUrl.replace(/:\/\/[^@]*@/, '://***@')}`)
} finally {
  await sql.end({ timeout: 1 })
}
