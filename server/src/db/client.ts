import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Db = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql }

export function createDb(url: string): Db {
  const sql = postgres(url, { max: 10 })
  return drizzle(sql, { schema, casing: 'snake_case' })
}
