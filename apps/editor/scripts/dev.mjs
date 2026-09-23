// Development: Vite dev server (renderer, with HMR) + esbuild watch (main, preload, host) + Electron.
// Electron restarts whenever main, preload or host code changes; renderer changes hot-reload.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import electronPath from 'electron';
import * as esbuild from 'esbuild';
import { createServer } from 'vite';
import { appDir, hostOptions, mainOptions, preloadOptions } from './esbuild.config.mjs';

const vite = await createServer({ configFile: join(appDir, 'vite.config.ts'), mode: 'development' });
await vite.listen();
const url = vite.resolvedUrls?.local[0] ?? 'http://localhost:5173/';
console.log(`[dev] renderer at ${url}`);

let electron = null;
let restarting = false;
let restartTimer = null;
let ready = 0;

function startElectron() {
  electron = spawn(String(electronPath), ['.', ...process.argv.slice(2)], {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, AIGE_DEV_SERVER_URL: url },
  });
  electron.on('exit', (code) => {
    if (restarting) return;
    console.log(`[dev] electron exited (${code ?? 0})`);
    void shutdown();
  });
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (!electron) return startElectron();
    restarting = true;
    electron.once('exit', () => {
      restarting = false;
      startElectron();
    });
    electron.kill();
  }, 200);
}

// Restart Electron only when a bundle's output actually changed (watch mode can report no-op rebuilds).
const reloadPlugin = (name, outfile) => ({
  name: `aige-dev-${name}`,
  setup(build) {
    let lastHash = null;
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      let hash = '';
      try {
        hash = createHash('sha1')
          .update(await readFile(join(appDir, outfile)))
          .digest('hex');
      } catch {
        return;
      }
      if (lastHash === null) {
        lastHash = hash;
        if (++ready === 3) startElectron();
        return;
      }
      if (hash === lastHash) return;
      lastHash = hash;
      console.log(`[dev] ${name} rebuilt, restarting electron`);
      scheduleRestart();
    });
  },
});

const contexts = await Promise.all(
  [
    ['main', mainOptions(true)],
    ['preload', preloadOptions(true)],
    ['host', hostOptions(true)],
  ].map(([name, opts]) =>
    esbuild.context({ ...opts, plugins: [...(opts.plugins ?? []), reloadPlugin(name, opts.outfile)] }),
  ),
);
await Promise.all(contexts.map((c) => c.watch()));

async function shutdown() {
  await Promise.all(contexts.map((c) => c.dispose()));
  await vite.close();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restarting = true;
    electron?.kill();
    void shutdown();
  });
}
