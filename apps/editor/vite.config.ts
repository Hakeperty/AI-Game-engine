import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

// Renderer (React UI). Served by the Vite dev server in development and from dist/renderer through the
// app:// protocol in production.
export default defineConfig({
  root: resolve(here, 'src/renderer'),
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  server: { port: 5173, strictPort: false, host: '127.0.0.1' },
  build: {
    outDir: resolve(here, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome140',
    // AIGE_DEBUG_BUILD=1 keeps the renderer readable for debugging production-only issues.
    sourcemap: !!process.env.AIGE_DEBUG_BUILD,
    minify: !process.env.AIGE_DEBUG_BUILD,
    chunkSizeWarningLimit: 8000,
    reportCompressedSize: false,
    rolldownOptions: {
      output: {
        // Keep three.js (shared by the viewport and the lazily loaded Play mode) in one chunk; automatic
        // splitting otherwise spreads it over chunks that import each other (TDZ errors at startup).
        codeSplitting: {
          groups: [
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/, priority: 20 },
            {
              name: 'vendor',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler|zustand|immer|zod|dockview|dockview-core)[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
