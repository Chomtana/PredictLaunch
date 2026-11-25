/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The sequencer (HTTP + WebSocket) is proxied so the app talks to its own origin.
const api = process.env.BILAUNCHER_API ?? 'http://127.0.0.1:8787'
const proxy = {
  '/api': { target: api, changeOrigin: true },
  '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
}

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 900 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
