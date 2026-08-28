import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // 端口 3000 定案（#20/#21）；VITE_API_ORIGIN 可覆盖
      '/api': {
        target: process.env.VITE_API_ORIGIN ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
