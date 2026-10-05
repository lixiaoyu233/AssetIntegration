/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 子路径部署：使用相对路径 base，产物可直接放到任意子目录下。
// https://vitejs.dev/config/shared-options.html#base
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    open: false,
    // 本地开发时的可选代理（生产环境走 CORS/JSONP，无需代理）。
    // 若浏览器直连被拦截，可把 fundService 的 provider 切到 '/eastmoney' 前缀。
    proxy: {
      '/eastmoney': {
        target: 'https://fundmobapi.eastmoney.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/eastmoney/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2019',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /*
     * Dexie 需要 IndexedDB 与 DOM 全局；node 环境下由 setup 文件注入
     * fake-indexeddb（仅测试用，不影响生产包）。
     */
    setupFiles: ['./src/test/setup.ts'],
  },
})
