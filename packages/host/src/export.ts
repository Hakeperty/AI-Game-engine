import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AigeError, defineCommand, type Entity, type ImageRef } from '@aige/core';
import { toBase64 } from '@aige/modeling';
import * as esbuild from 'esbuild';
import { z } from 'zod';
import type { ProjectHost } from './host.ts';
import { RUNTIME_GLOBAL } from './play.ts';
import { launchChromium } from './render/playwright.ts';
import { compileUserModule } from './sandbox.ts';

const PLAYER_ENTRY = resolve(import.meta.dirname, '..', '..', 'player', 'src', 'main.ts');

let playerBundle: Promise<string> | null = null;

/** Bundles @aige/player (three.js + runtime + renderer) into one minified script. Cached per process. */
export function playerScript(): Promise<string> {
  playerBundle ??= esbuild
    .build({
      entryPoints: [PLAYER_ENTRY],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      legalComments: 'none',
      logLevel: 'silent',
    })
    .then((r) => r.outputFiles[0]!.text);
  return playerBundle;
}

function indexHtml(title: string): string {
  const safe = title.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safe}</title>
<style>
  html, body { margin: 0; height: 100%; background: #0f1115; overflow: hidden; font-family: system-ui, 'Segoe UI', sans-serif; }
  #game { position: fixed; inset: 0; }
  #game canvas { display: block; width: 100%; height: 100%; }
  #start { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: rgba(10, 12, 18, 0.72); color: #fff; cursor: pointer; z-index: 10; user-select: none; }
  #start h1 { font-size: clamp(28px, 6vw, 64px); margin: 0 0 12px; letter-spacing: 0.02em; }
  #start p { opacity: 0.8; margin: 4px; }
  #start .hint { font-size: 14px; opacity: 0.6; margin-top: 18px; }
</style>
</head>
<body>
<div id="game"></div>
<div id="start"><h1>${safe}</h1><p>Click or press any key to play</p><p class="hint">WASD / arrows to move · Space to jump · R to restart after game over</p></div>
<script src="game-data.js"></script>
<script src="player.js"></script>
</body>
</html>
`;
}

export interface ExportResult {
  path: string;
  files: { name: string; bytes: number }[];
  models: number;
  scripts: number;
  smoke?: { frames: number; errors: string[]; gpu: string; image?: ImageRef };
}

/** Builds a standalone static web build of the project into `out` (project-relative). */
export async function exportWeb(host: ProjectHost, opts: { out?: string; title?: string; smokeTest?: boolean } = {}): Promise<ExportResult> {
  const state = host.state;
  const out = (opts.out ?? 'dist').replaceAll('\\', '/').replace(/\/$/, '');
  if (out.startsWith('..') || out === '' || out === '.' || /^(models|scripts|scenes|materials|prefabs|textures)$/.test(out)) {
    throw new AigeError('INVALID_INPUT', `Refusing to export into '${out}'.`, { hint: "Use a dedicated folder like 'dist'." });
  }
  const title = opts.title ?? (state.project.window.title || state.project.name);

  // Models: every (path, params) used by scenes and prefabs.
  const models: Record<string, string> = {};
  const modelInfos: Record<string, { bounds: unknown; collider: unknown }> = {};
  const meshKeys: Record<string, Record<string, string>> = {};
  const modelKeysByPath: Record<string, string> = {};
  const build = async (path: string, params: Record<string, unknown>): Promise<string> => {
    const built = await host.assets.build(path, params);
    const key = built.info.key;
    if (!models[key]) {
      models[key] = toBase64(built.glb);
      modelInfos[key] = { bounds: built.info.bounds, collider: built.info.collider };
    }
    return key;
  };
  const visit = async (entities: Entity[], bucket: Record<string, string> | null) => {
    for (const e of entities) {
      const mr = e.components.find((c) => c.type === 'MeshRenderer');
      if (!mr?.model) continue;
      const path = mr.model as string;
      const params = (mr.params as Record<string, unknown>) ?? {};
      modelKeysByPath[path] ??= await build(path, {});
      const key = Object.keys(params).length ? await build(path, params) : modelKeysByPath[path]!;
      if (bucket) bucket[e.id] = key;
    }
  };
  for (const [path, scene] of Object.entries(state.scenes)) {
    meshKeys[path] = {};
    await visit(scene.entities, meshKeys[path]);
  }
  for (const prefab of Object.values(state.prefabs)) await visit(prefab.entities, null);

  // Scripts referenced anywhere.
  const scriptPaths = new Set<string>();
  for (const e of [...Object.values(state.scenes).flatMap((s) => s.entities), ...Object.values(state.prefabs).flatMap((p) => p.entities)]) {
    for (const c of e.components) {
      if (c.type === 'Script' && typeof c.script === 'string' && !c.script.startsWith('builtin:')) scriptPaths.add(c.script);
    }
  }
  const scripts: Record<string, string> = {};
  for (const path of scriptPaths) {
    const mod = await compileUserModule({ entry: host.fs.abs(path), root: host.root, virtuals: { aige: RUNTIME_GLOBAL } });
    scripts[path] = `${mod.code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(mod.map).toString('base64')}`;
  }

  const textures = await host.render.collectTextures(state);
  const data = {
    title,
    project: state.project,
    startScene: state.project.startScene,
    scenes: state.scenes,
    prefabs: state.prefabs,
    materials: state.materials,
    meshKeys,
    modelKeysByPath,
    modelInfos,
    models,
    textures,
    scripts,
  };
  await rm(host.fs.abs(out), { recursive: true, force: true });
  const files: { name: string; bytes: number }[] = [];
  const write = async (name: string, content: string) => {
    await host.fs.write(`${out}/${name}`, content);
    files.push({ name, bytes: Buffer.byteLength(content) });
  };
  await write('index.html', indexHtml(title));
  await write('game-data.js', `window.__AIGE_GAME__ = ${JSON.stringify(data)};\n`);
  await write('player.js', await playerScript());
  const result: ExportResult = { path: `${out}/index.html`, files, models: Object.keys(models).length, scripts: Object.keys(scripts).length };
  if (opts.smokeTest !== false) result.smoke = await smokeTest(host, `${out}/index.html`);
  return result;
}

/** Opens the exported game in headless Chromium, starts it, lets it run and reports errors + a screenshot. */
async function smokeTest(host: ProjectHost, indexPath: string): Promise<NonNullable<ExportResult['smoke']>> {
  const { browser, page, label } = await launchChromium();
  const errors: string[] = [];
  try {
    page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.setViewportSize({ width: 960, height: 540 });
    await page.goto(pathToFileURL(host.fs.abs(indexPath)).href);
    await page.waitForFunction(() => (window as any).__aigePlayer?.world != null || ((window as any).__aigePlayer?.errors?.length ?? 0) > 0, undefined, { timeout: 30_000 });
    await page.mouse.click(480, 270);
    await page.waitForTimeout(2500);
    const status = (await page.evaluate(() => {
      const p = (window as any).__aigePlayer;
      return { frames: p?.frames ?? 0, errors: p?.errors ?? [] };
    })) as { frames: number; errors: string[] };
    const png = await page.screenshot({ type: 'png' });
    const shotPath = '.aige/screenshots/export-smoke.png';
    await host.fs.write(shotPath, png);
    return {
      frames: status.frames,
      errors: [...status.errors, ...errors].slice(0, 20),
      gpu: label,
      image: { mimeType: 'image/png', data: png.toString('base64'), label: 'exported game after 2.5 s', path: shotPath, width: 960, height: 540 },
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export const exportWebCommand = defineCommand({
  name: 'export_web',
  group: 'export',
  kind: 'action',
  tier: 'core',
  description:
    'Build a standalone playable web version of the game into dist/ (index.html + player.js + game-data.js; works from file:// or any static host). Models are baked to GLB and scripts are compiled. By default it smoke-tests the build in a headless browser and returns a screenshot and any errors. Example: {"out":"dist","title":"Coin Quest"}',
  input: z
    .object({
      out: z.string().default('dist'),
      title: z.string().optional(),
      smokeTest: z.boolean().default(true),
    })
    .strict(),
  async run(ctx, input) {
    const host = (ctx.services as { host: ProjectHost }).host;
    const res = await exportWeb(host, { out: input.out, ...(input.title ? { title: input.title } : {}), smokeTest: input.smokeTest });
    const { smoke, ...rest } = res;
    return {
      ...rest,
      absolutePath: host.fs.abs(res.path),
      ...(smoke
        ? { smoke: { frames: smoke.frames, errors: smoke.errors, ok: smoke.errors.length === 0 && smoke.frames > 10, renderer: smoke.gpu } }
        : {}),
      ...(smoke?.image ? { images: [smoke.image] } : {}),
    };
  },
});
