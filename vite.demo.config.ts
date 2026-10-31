// Demo web: la interfaz de la aplicación con datos de ejemplo (npm run demo:build → demo/dist).
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  publicDir: resolve(__dirname, 'demo/web'),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'demo/dist'),
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/demo.html') } }
  }
})
