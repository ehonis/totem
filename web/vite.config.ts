import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Built to web/dist and served by bridge.mjs on :8787. The dev-server proxy below
// is only used if you run `npm run dev`; in the shipped setup the bridge serves
// both the static app and the /api endpoints from the same origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // `ws: true` so the terminal panel's WebSocket (/api/terminal/ws) proxies
      // too — without it the socket 404s under `npm run dev` while every other
      // /api call works, which is a confusing way to lose an afternoon.
      '/api': { target: 'http://localhost:8787', ws: true },
      '/health': 'http://localhost:8787',
    },
  },
  // noVNC (the Screen view) uses top-level await, which Vite's default target
  // (Safari 14 era) cannot emit. These are the first versions that run it.
  build: { outDir: 'dist', emptyOutDir: true, target: ['es2022', 'chrome89', 'edge89', 'firefox89', 'safari15'] },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
})
