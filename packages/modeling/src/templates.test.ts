import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildRecipe, exportGlb, initModeling, isRecipe, toMeshData, validateModel } from './index.ts';

const dir = join(import.meta.dirname, '..', 'templates');
const files = readdirSync(dir).filter((f) => f.endsWith('.model.ts'));
/** Skinned humans: bigger budget, slower builds (the seed check uses low detail). */
const CHARACTERS = new Set(['human.model.ts', 'young_man.model.ts', 'boy.model.ts', 'woman.model.ts']);

beforeAll(async () => {
  await initModeling();
});

describe('model templates', () => {
  it('there are at least 23 templates', () => {
    expect(files.length).toBeGreaterThanOrEqual(23);
  });

  it.each(files)(
    '%s builds, validates and exports',
    async (file) => {
      const character = CHARACTERS.has(file);
      const mod = await import(join(dir, file));
      expect(isRecipe(mod.default)).toBe(true);
      const model = buildRecipe(mod.default, {});
      const report = validateModel(model);
      expect(report.triangles).toBeGreaterThan(10);
      expect(report.triangles, `${file} triangle budget`).toBeLessThan(character ? 45_000 : 30_000);
      for (const part of report.parts) {
        expect(part.report.degenerateFaces, `${file}/${part.name}`).toBeLessThan(
          part.report.faces * 0.02 + 1,
        );
        expect(part.report.insideOut, `${file}/${part.name} inside out`).toBe(false);
        expect(part.report.nonManifoldEdges, `${file}/${part.name} non-manifold`).toBe(0);
        expect(part.report.watertight, `${file}/${part.name} watertight`).toBe(true);
      }
      const size = Math.max(...report.bounds.size);
      expect(size).toBeGreaterThan(0.05);
      expect(size).toBeLessThan(10);
      const data = toMeshData(model);
      expect(data.parts.length).toBeGreaterThan(0);
      const glb = await exportGlb(model);
      expect(glb.byteLength).toBeGreaterThan(500);
      // different seeds must not crash (and must stay solid)
      for (const part of validateModel(
        buildRecipe(mod.default, character ? { seed: 42, detail: 'low', clips: 'none' } : { seed: 42 }),
      ).parts)
        expect(part.report.watertight, `${file}/${part.name} seed 42`).toBe(true);
    },
    90_000,
  );
});
