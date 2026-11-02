/**
 * Airwave Discovery demo build.
 *
 * Same consumption pattern as the hub's admin GUI (docker-container/src/web): the Aqua window kit,
 * the Aqua art and the icon set come straight from packages/aqua-ui source. Everything is bundled;
 * the only remote requests the page makes are artwork, previews and embeds the user asks for.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = fileURLToPath(new URL('.', import.meta.url));
const aqua = (p: string) => fileURLToPath(new URL(`../../packages/aqua-ui/src/${p}`, import.meta.url));
const backend = `http://127.0.0.1:${process.env['AIRWAVE_DISCOVERY_PORT'] || 8787}`;

export default defineConfig({
  root: here,
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      // Stylesheet and sub-path entries before anything shorter: string aliases match by prefix.
      '@now-playing/aqua-ui/airwave-window.css': aqua('styles/airwave-window.css'),
      '@now-playing/aqua-ui/airwave-art': aqua('airwave/aqua-art.ts'),
      '@now-playing/aqua-ui/icons': aqua('icons/index.ts'),
    },
  },
  // The audio worker imports onnxruntime lazily, which needs ES-module workers.
  worker: { format: 'es' },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 600,
  },
  server: {
    host: '127.0.0.1',
    port: 5181,
    strictPort: true,
    proxy: { '/api': { target: backend, changeOrigin: false } },
  },
});
