import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildApp } from '../src/app.js'

test('GET /api/health → 200 { status, db }（Postgres 已由 compose 起好）', async () => {
  const app = await buildApp()
  try {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { status: 'ok', db: 'ok' })
  } finally {
    await app.close()
  }
})

test('未知路由 → 404 统一错误形状', async () => {
  const app = await buildApp()
  try {
    const res = await app.inject({ method: 'GET', url: '/api/nope' })
    assert.equal(res.statusCode, 404)
    assert.deepEqual(res.json(), {
      error: { code: 'NOT_FOUND', message: 'Route GET /api/nope not found' },
    })
  } finally {
    await app.close()
  }
})
