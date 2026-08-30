import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import App from './App.tsx'
import { Toaster } from '@/components/ui/sonner'
import { queryClient } from '@/lib/query-client'
import './index.css'

// ThemeProvider 是 next-themes 的入口：此前缺它，useTheme() 只返回默认 "system"，
// 深色模式实际从未生效（sonner 的 theme 也一直是空转）。
// attribute="class" 对应 index.css 的 @custom-variant dark (&:is(.dark *))。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <App />
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
