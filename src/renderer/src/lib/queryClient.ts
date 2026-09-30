import { QueryClient } from '@tanstack/react-query'

/**
 * 全局 QueryClient。
 * - IPC 读操作即「服务端数据」：staleTime 内直接复用缓存，跨页共享
 * - 写操作后由调用方 invalidate 对应 key 前缀（见 lib/queries.ts 的 qk）
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false
    }
  }
})
