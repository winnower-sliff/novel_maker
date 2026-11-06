import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../src/shared'),
      '@mobile': resolve(__dirname, './src')
    }
  },
  build: {
    outDir: resolve(__dirname, '../dist-mobile'),
    emptyOutDir: true,
    target: 'es2022'
  },
  define: {
    // 版本标签：优先取 build-apk.mjs 注入的 NM_APK_VERSION（与 APK versionName 同源同时钟）；
    // 裸 vite build 场景回退本地时钟（UTC 会比 APK 标签早 8 小时，曾被当成「没更新成功」）
    __APP_VERSION__: JSON.stringify(
      process.env.NM_APK_VERSION ??
        (() => {
          const d = new Date()
          const p2 = (n: number) => String(n).padStart(2, '0')
          return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}`
        })()
    )
  }
})
