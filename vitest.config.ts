import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Virtual modules that user recipes/scripts import; the host maps them the same way at build time.
    alias: [
      { find: /^aige\/model$/, replacement: src('./packages/modeling/src/index.ts') },
      { find: /^aige$/, replacement: src('./packages/runtime/src/api.ts') },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.render.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
