// Render tests: need a headless Chromium (npx playwright-core install chromium-headless-shell).
// Run with: AIGE_RENDER_TESTS=1 npx vitest run packages/host/src/render.render.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng, fromBase64 } from '@aige/modeling';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectHost } from './index.ts';

let host: ProjectHost;

beforeAll(async () => {
  host = await ProjectHost.create(mkdtempSync(join(tmpdir(), 'aige-render-')), { name: 'render' });
});
afterAll(async () => {
  await host?.close();
});

/** Standard deviation of luminance: a blank or single-color image is ~0. */
function variance(b64: string): { w: number; h: number; std: number; mean: number } {
  const img = decodePng(fromBase64(b64));
  let sum = 0;
  let sum2 = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const l = 0.2126 * img.data[i * 4]! + 0.7152 * img.data[i * 4 + 1]! + 0.0722 * img.data[i * 4 + 2]!;
    sum += l;
    sum2 += l * l;
  }
  const mean = sum / n;
  return { w: img.width, h: img.height, mean, std: Math.sqrt(sum2 / n - mean * mean) };
}

async function ok(name: string, input: unknown): Promise<any> {
  const r = await host.call(name, input, 'test');
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.result;
}

describe('headless rendering', () => {
  it('previews a model from several angles', async () => {
    await ok('model_from_template', { template: 'crate', preview: false });
    const res = await ok('model_preview', { model: 'crate', size: 512 });
    const v = variance(res.images[0].data);
    expect(v.w).toBe(512);
    expect(v.std).toBeGreaterThan(10);
  }, 60_000);

  it('renders the scene with camera and iso views', async () => {
    await ok('entity_create', {
      name: 'Crate',
      position: [0, 0, 0],
      components: [{ type: 'MeshRenderer', model: 'models/crate.model.ts' }],
    });
    await ok('entity_create', {
      name: 'Ball',
      position: [2, 0.5, 0],
      components: [{ type: 'MeshRenderer', primitive: 'sphere', color: '#e53935' }],
    });
    const res = await ok('render_screenshot', { width: 800, height: 400 });
    const v = variance(res.images[0].data);
    expect(v.w).toBe(800);
    expect(v.std).toBeGreaterThan(8);
    expect(res.triangles).toBeGreaterThan(20);
  }, 60_000);
});
