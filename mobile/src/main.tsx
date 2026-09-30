import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installBridge } from './lib/bridge'
import { loadConn } from './lib/conn'
import './styles.css'

if (loadConn()) installBridge()

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 }
  }
})

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </StrictMode>
)

// Android 原生更新层轮询此标记：渲染完成才揭覆盖层
;(window as unknown as Record<string, unknown>).__NM_READY__ = true
