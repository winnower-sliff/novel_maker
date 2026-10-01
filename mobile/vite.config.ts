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
      '@mobile': resolve(__dirname, './src'),
      '@wizard': resolve(__dirname, '../src/wizard'),
      '@renderer': resolve(__dirname, '../src/renderer/src')
    }
  },
  build: {
    outDir: resolve(__dirname, '../dist-mobile'),
    emptyOutDir: true,
    target: 'es2022'
  },
  define: {
    __APP_VERSION__: JSON.stringify(new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ''))
  }
})
