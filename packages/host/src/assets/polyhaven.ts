import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AigeError, canonicalJson, createMaterialDoc, defineCommand } from '@aige/core';
import { NodeIO } from '@gltf-transform/core';
import { z } from 'zod';
import type { ProjectHost } from '../host.ts';

/**
 * Poly Haven (https://polyhaven.com): free CC0 scanned PBR textures, HDRIs and models. No API key.
 * Downloads go into the project (textures/polyhaven, textures/hdri, models/polyhaven) and every asset is
 * credited in CREDITS.md.
 */
type Services = { host: ProjectHost };
const hostOf = (ctx: { services: unknown }) => (ctx.services as Services).host;

const API = 'https://api.polyhaven.com';
const KINDS = { texture: 'textures', hdri: 'hdris', model: 'models' } as const;
type Kind = keyof typeof KINDS;

interface AssetInfo {
  name: string;
  categories: string[];
  tags: string[];
  description?: string;
  authors: Record<string, string>;
  dimensions?: [number, number];
}

const catalogs = new Map<Kind, Promise<Record<string, AssetInfo>>>();

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': 'AIGE game engine' } });
  if (!res.ok) throw new AigeError('IO_ERROR', `Poly Haven request failed (${res.status}): ${url}`);
  return (await res.json()) as T;
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { 'User-Agent': 'AIGE game engine' } });
  if (!res.ok) throw new AigeError('IO_ERROR', `Download failed (${res.status}): ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

function catalog(kind: Kind) {
  let c = catalogs.get(kind);
  if (!c) {
    c = getJson<Record<string, AssetInfo>>(`${API}/assets?t=${KINDS[kind]}`);
    c.catch(() => catalogs.delete(kind));
    catalogs.set(kind, c);
  }
  return c;
}

function score(id: string, a: AssetInfo, words: string[]): number {
  let s = 0;
  const hay = {
    id: id.replaceAll('_', ' '),
    name: a.name.toLowerCase(),
    tags: a.tags.join(' ').toLowerCase(),
    cats: a.categories.join(' ').toLowerCase(),
    desc: (a.description ?? '').toLowerCase(),
  };
  for (const w of words) {
    if (hay.id.includes(w) || hay.name.includes(w)) s += 3;
    if (hay.tags.includes(w)) s += 2;
    if (hay.cats.includes(w)) s += 1.5;
    if (hay.desc.includes(w)) s += 1;
  }
  return s;
}

async function credit(host: ProjectHost, id: string, info: AssetInfo, kind: Kind, path: string) {
  const line = `- **${info.name}** (${kind}) by ${Object.keys(info.authors).join(', ')}, [Poly Haven](https://polyhaven.com/a/${id}), CC0: \`${path}\``;
  const current =
    (await host.fs.read('CREDITS.md')) ?? '# Credits\n\nThird-party assets used by this game.\n\n';
  if (current.includes(`polyhaven.com/a/${id})`)) return;
  await host.fs.write('CREDITS.md', `${current.trimEnd()}\n${line}\n`);
}

export const assetSearch = defineCommand({
  name: 'asset_search',
  group: 'assets',
  kind: 'query',
  tier: 'core',
  description: `Search Poly Haven's free CC0 library of realistic scanned PBR textures, HDRI skies and models. Use it for realistic surfaces (wood, bark, plaster, stone, metal, fabric, dirt), then asset_fetch the id.
Example: {"kind":"texture","query":"old wooden floor planks"}`,
  input: z
    .object({
      kind: z.enum(['texture', 'hdri', 'model']).default('texture'),
      query: z
        .string()
        .min(2)
        .describe("Words to match, e.g. 'log cabin wall', 'rusty metal', 'moonlit night'"),
      limit: z.number().int().min(1).max(40).default(12),
    })
    .strict(),
  async run(_ctx, input) {
    const all = await catalog(input.kind);
    const words = input.query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1);
    const hits = Object.entries(all)
      .map(([id, a]) => ({ id, a, s: score(id, a, words) }))
      .filter((h) => h.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, input.limit);
    return {
      results: hits.map(({ id, a }) => ({
        id,
        name: a.name,
        categories: a.categories.slice(0, 4),
        tags: a.tags.slice(0, 8),
        ...(a.description ? { description: a.description.slice(0, 140) } : {}),
      })),
      next: hits.length ? `asset_fetch {"kind":"${input.kind}","id":"${hits[0]!.id}"}` : 'Try other words.',
    };
  },
});

interface FileRef {
  url: string;
  size: number;
  include?: Record<string, { url: string; size: number }>;
}
type FileTree = Record<string, Record<string, Record<string, FileRef>>>;

export const assetFetch = defineCommand({
  name: 'asset_fetch',
  group: 'assets',
  kind: 'mutation',
  tier: 'core',
  description: `Download a Poly Haven CC0 asset into the project (and credit it in CREDITS.md).
- texture: color, normal and packed AO/roughness/metal maps into textures/polyhaven/<id>/, plus materials/<name>.material.json ready for MeshRenderer.material or MeshRenderer.materials (per part). Set mapRepeat for big surfaces.
- hdri: an equirectangular .hdr sky into textures/hdri/ for Environment lighting and reflections.
- model: a glTF model converted to models/polyhaven/<id>.glb for MeshRenderer.model.
Example: {"kind":"texture","id":"old_wooden_floor_02","resolution":"1k","name":"floor_old_wood","repeat":[2,2]}`,
  input: z
    .object({
      kind: z.enum(['texture', 'hdri', 'model']).default('texture'),
      id: z.string().regex(/^[a-z0-9_]+$/, 'Use the id from asset_search'),
      resolution: z
        .enum(['1k', '2k', '4k'])
        .default('1k')
        .describe('1k is plenty for props; 2k for floors and walls seen up close'),
      name: z
        .string()
        .regex(/^[a-z0-9_-]+$/i)
        .optional()
        .describe('Material name for textures (default: the id)'),
      repeat: z
        .tuple([z.number().positive(), z.number().positive()])
        .default([1, 1])
        .describe('Texture tiling for the material'),
      displacement: z.boolean().default(false).describe('Also download the height map (textures only)'),
    })
    .strict(),
  async run(ctx, input) {
    const host = hostOf(ctx);
    const all = await catalog(input.kind);
    const info = all[input.id];
    if (!info) {
      const words = input.id.split('_');
      const near = Object.keys(all)
        .filter((id) => words.some((w) => w.length > 2 && id.includes(w)))
        .slice(0, 8);
      throw new AigeError('NOT_FOUND', `No Poly Haven ${input.kind} '${input.id}'.`, {
        hint: near.length ? `Similar: ${near.join(', ')}` : 'Use asset_search first.',
      });
    }
    const files = await getJson<FileTree>(`${API}/files/${input.id}`);
    const res = input.resolution;

    if (input.kind === 'texture') {
      const pick = (map: string, fmt = 'jpg') => files[map]?.[res]?.[fmt] ?? files[map]?.['1k']?.[fmt];
      const dir = `textures/polyhaven/${input.id}`;
      const saved: Record<string, string> = {};
      const want: [string, string][] = [
        ['Diffuse', 'color'],
        ['nor_gl', 'normal'],
        ['arm', 'orm'],
      ];
      if (input.displacement) want.push(['Displacement', 'height']);
      for (const [map, role] of want) {
        const ref = pick(map);
        if (!ref) continue;
        const path = `${dir}/${ref.url.split('/').pop()}`;
        if (!(await host.fs.exists(path))) await host.fs.write(path, await download(ref.url));
        saved[role] = path;
      }
      if (!saved.color) throw new AigeError('NOT_FOUND', `Texture '${input.id}' has no color map at ${res}.`);
      const name = input.name ?? input.id;
      const matPath = `materials/${name}.material.json`;
      const doc = createMaterialDoc({
        map: saved.color,
        mapRepeat: input.repeat,
        ...(saved.normal ? { normalMap: saved.normal } : {}),
        ...(saved.orm ? { ormMap: saved.orm, roughness: 1, metalness: 1 } : { roughness: 0.85 }),
      });
      await ctx.writeFile(matPath, canonicalJson(doc));
      await credit(host, input.id, info, 'texture', dir);
      return {
        material: matPath,
        maps: saved,
        size: info.dimensions
          ? `${info.dimensions[0] / 1000} x ${info.dimensions[1] / 1000} m real-world`
          : undefined,
        next: `component_update {"entity":"...","type":"MeshRenderer","props":{"material":"${matPath}"}}`,
      };
    }

    if (input.kind === 'hdri') {
      const ref = files.hdri?.[res]?.hdr ?? files.hdri?.['1k']?.hdr;
      if (!ref) throw new AigeError('NOT_FOUND', `HDRI '${input.id}' has no .hdr file.`);
      const path = `textures/hdri/${ref.url.split('/').pop()}`;
      if (!(await host.fs.exists(path))) await host.fs.write(path, await download(ref.url));
      await credit(host, input.id, info, 'hdri', path);
      return { hdri: path, next: 'Use it as the Environment sky/lighting (hdri).' };
    }

    // model: download the glTF with its buffers and textures, then pack a single GLB
    const ref = files.gltf?.[res]?.gltf ?? files.gltf?.['1k']?.gltf;
    if (!ref) throw new AigeError('NOT_FOUND', `Model '${input.id}' has no glTF download.`);
    const tmp = await mkdtemp(join(tmpdir(), 'aige-ph-'));
    try {
      const gltfPath = join(tmp, ref.url.split('/').pop()!);
      await writeFile(gltfPath, await download(ref.url));
      for (const [rel, inc] of Object.entries(ref.include ?? {})) {
        const out = join(tmp, rel);
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, await download(inc.url));
      }
      const io = new NodeIO();
      const doc = await io.read(gltfPath);
      const glb = await io.writeBinary(doc);
      const path = `models/polyhaven/${input.id}.glb`;
      await host.fs.write(path, glb);
      await credit(host, input.id, info, 'model', path);
      return {
        model: path,
        bytes: glb.byteLength,
        next: `entity_create {"name":"${info.name}","components":[{"type":"MeshRenderer","model":"${path}"}]}`,
      };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
});

export const assetCommands = [assetSearch, assetFetch];
