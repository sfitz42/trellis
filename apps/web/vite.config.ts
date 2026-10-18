import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// In dev the SPA runs on :5173 and proxies the API and websocket to the server (PLAN.md §2, §8).
const server = process.env['TRELLIS_SERVER'] ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': server,
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
