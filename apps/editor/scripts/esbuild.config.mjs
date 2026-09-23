// Shared esbuild options for the Electron main process, the preload script and the host utility process.
// The renderer is a plain Vite app (see vite.config.ts).
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const distDir = join(appDir, 'dist');

/**
 * @aige/* packages are source-first TypeScript and locate engine files (model templates, the render page,
 * the TypeScript compiler) relative to `import.meta.dirname`. Once bundled into dist/ that would point at
 * the wrong folder, so every `import.meta.*` in package sources is replaced with the source file's real
 * location. The build therefore runs against this engine checkout (it needs the templates, the render page
 * source and TypeScript for script type-checking anyway).
 */
const importMetaPlugin = {
  name: 'aige-import-meta',
  setup(build) {
    build.onLoad({ filter: /[\\/]packages[\\/][^\\/]+[\\/]src[\\/].*\.ts$/ }, async (args) => {
      let contents = await readFile(args.path, 'utf8');
      if (contents.includes('import.meta')) {
        contents = contents
          .replaceAll('import.meta.dirname', JSON.stringify(dirname(args.path)))
          .replaceAll('import.meta.filename', JSON.stringify(args.path))
          .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(args.path).href));
      }
      return { contents, loader: 'ts' };
    });
  },
};

/**
 * Bundle our own code and the @aige/* workspace packages; keep every real node_modules package external
 * so native binaries and WASM (esbuild, playwright-core, manifold-3d, ...) load exactly as installed.
 */
const externalizeDeps = {
  name: 'aige-externalize-deps',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') return undefined;
      const p = args.path;
      if (p.startsWith('.') || p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return undefined;
      if (p.startsWith('@aige/')) return undefined;
      return { path: p, external: true };
    });
  },
};

/** @returns {import('esbuild').BuildOptions} */
export function mainOptions(dev) {
  return {
    absWorkingDir: appDir,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: dev ? 'inline' : false,
    external: ['electron'],
    define: { 'process.env.AIGE_BUILD_MODE': JSON.stringify(dev ? 'development' : 'production') },
    logLevel: 'warning',
  };
}

/** Sandboxed preloads can only `require('electron')`, so everything else is bundled. */
export function preloadOptions(dev) {
  return {
    absWorkingDir: appDir,
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'chrome140',
    sourcemap: dev ? 'inline' : false,
    external: ['electron'],
    logLevel: 'warning',
  };
}

/**
 * The host runs in an Electron utility process. It is emitted as ESM because some dependencies
 * (manifold-3d) are ESM-only and cannot be `require`d.
 */
export function hostOptions(dev) {
  return {
    absWorkingDir: appDir,
    entryPoints: ['src/host/index.ts'],
    outfile: 'dist/host.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: dev ? 'inline' : 'linked',
    plugins: [importMetaPlugin, externalizeDeps],
    banner: {
      js: "import { createRequire as __aigeCreateRequire } from 'node:module'; const require = __aigeCreateRequire(import.meta.url);",
    },
    logLevel: 'warning',
  };
}
