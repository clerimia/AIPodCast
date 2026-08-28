import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { AppError } from '../../shared/errors.js'

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    try {
      await app.db.execute(sql`select 1`)
    } catch {
      throw new AppError('DB_UNAVAILABLE', 'database is not reachable', 503)
    }
    return { status: 'ok', db: 'ok' }
  })
}
