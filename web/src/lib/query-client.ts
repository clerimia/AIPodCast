// 全局唯一 QueryClient：main.tsx 挂 Provider；writer-run-controller 的流生命周期
// 在组件树之外（导航不中断），其 script:changed → 缓存失效直接 import 本单例。
import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})
