import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildRecipe, exportGlb, initModeling, isRecipe, toMeshData, validateModel } from './index.ts';

const dir = join(import.meta.dirname, '..', 'templates');
const files = readdirSync(dir).filter((f) => f.endsWith('.model.ts'));

beforeAll(async () => {
  await initModeling();
});

describe('model templates', () => {
  it('there are at least 12 templates', () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  it.each(files)('%s builds, validates and exports', async (file) => {
    const mod = await import(join(dir, file));
    expect(isRecipe(mod.default)).toBe(true);
    const model = buildRecipe(mod.default, {});
    const report = validateModel(model);
    expect(report.triangles).toBeGreaterThan(10);
    expect(report.triangles).toBeLessThan(150_000);
    for (const part of report.parts) {
      expect(part.report.degenerateFaces, `${file}/${part.name}`).toBeLessThan(part.report.faces * 0.02 + 1);
      expect(part.report.insideOut, `${file}/${part.name} inside out`).toBe(false);
    }
    const size = Math.max(...report.bounds.size);
    expect(size).toBeGreaterThan(0.05);
    expect(size).toBeLessThan(10);
    const data = toMeshData(model);
    expect(data.parts.length).toBeGreaterThan(0);
    const glb = await exportGlb(model);
    expect(glb.byteLength).toBeGreaterThan(500);
    // different seeds must not crash
    buildRecipe(mod.default, { seed: 42 });
  });
});
