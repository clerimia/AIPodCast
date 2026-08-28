import { buildApp } from './app.js'
import { env } from './env.js'

const app = await buildApp()

await app.listen({ port: env.port, host: '127.0.0.1' })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().finally(() => process.exit(0))
  })
}
