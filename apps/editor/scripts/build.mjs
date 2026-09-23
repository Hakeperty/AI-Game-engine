// Production build: esbuild for main/preload/host, Vite for the renderer. Output goes to dist/.
//   npm run build -w @aige/editor   then   npm run start -w @aige/editor
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';
import { appDir, distDir, hostOptions, mainOptions, preloadOptions } from './esbuild.config.mjs';

const started = Date.now();
await rm(distDir, { recursive: true, force: true });
await Promise.all([
  esbuild.build(mainOptions(false)),
  esbuild.build(preloadOptions(false)),
  esbuild.build(hostOptions(false)),
]);
console.log(`main, preload, host bundled in ${Date.now() - started} ms`);
await viteBuild({ configFile: join(appDir, 'vite.config.ts'), mode: 'production', logLevel: 'warn' });
console.log(`editor built in ${((Date.now() - started) / 1000).toFixed(1)} s -> ${distDir}`);
