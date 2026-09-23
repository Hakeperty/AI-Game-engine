import type { MaterialDoc } from '@aige/core';
import { ModelCache, type SceneRenderer } from '@aige/render';
import type { ModelAsset, ModelInfoLite } from '../../shared/protocol.ts';
import { host } from '../host/client.ts';
import { editor, log, useEditor } from '../store/editor.ts';

/**
 * Models come from the host's `model` message (recipe built by the asset pipeline -> GLB). One
 * ModelCache is shared by every viewport; entries are keyed by the host's content-hash model key.
 */
export const modelCache = new ModelCache();

const requests = new Map<string, Promise<{ key: string; info: ModelInfoLite } | null>>();
const infos = new Map<string, ModelInfoLite>();
const failed = new Set<string>();
let generation = 0;
const listeners = new Set<() => void>();

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

export function modelGeneration(): number {
  return generation;
}

export function onModelsInvalidated(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Builds (or reuses) a model; resolves null when the model fails to build (logged once). */
export function resolveModel(
  path: string,
  params: Record<string, unknown> = {},
): Promise<{ key: string; info: ModelInfoLite } | null> {
  const id = `${path}|${stable(params)}`;
  let p = requests.get(id);
  if (!p) {
    p = host
      .request<ModelAsset>({ type: 'model', path, params })
      .then(async (asset) => {
        await modelCache.add(asset.key, asset.glb);
        infos.set(asset.key, asset.info);
        failed.delete(id);
        return { key: asset.key, info: asset.info };
      })
      .catch((err: Error) => {
        if (!failed.has(id)) {
          failed.add(id);
          log('warn', `Model '${path}' failed to build: ${err.message}`, 'editor');
        }
        return null;
      });
    requests.set(id, p);
  }
  return p;
}

/** Fetches a model asset without caching the request (the modeling workspace always wants fresh info). */
export async function fetchModel(
  path: string,
  params: Record<string, unknown> = {},
): Promise<{ key: string; info: ModelInfoLite }> {
  const asset = await host.request<ModelAsset>({ type: 'model', path, params });
  await modelCache.add(asset.key, asset.glb);
  infos.set(asset.key, asset.info);
  return { key: asset.key, info: asset.info };
}

export function modelInfo(key: string): ModelInfoLite | undefined {
  return infos.get(key);
}

export function invalidateModels(): void {
  requests.clear();
  failed.clear();
  generation++;
  for (const l of listeners) l();
}

// Recipes can import helper files, so any change under models/ (or a .glb) invalidates model builds.
useEditor.subscribe((s, prev) => {
  if (s.root !== prev.root) {
    invalidateModels();
    return;
  }
  if (s.fileVersions === prev.fileVersions) return;
  for (const [path, v] of Object.entries(s.fileVersions)) {
    if (prev.fileVersions[path] === v) continue;
    if (path.startsWith('models/') || path.endsWith('.glb')) {
      invalidateModels();
      return;
    }
  }
});

// ------------------------------------------------------------------ textures

const textureData = new Map<string, { version: number; url: string }>();
const loadedBy = new WeakMap<SceneRenderer, Map<string, number>>();

/** Registers every texture referenced by the materials with this SceneRenderer's TextureCache. */
export async function ensureTextures(
  sr: SceneRenderer,
  materials: Record<string, MaterialDoc>,
): Promise<void> {
  const versions = editor.get().fileVersions;
  let mine = loadedBy.get(sr);
  if (!mine) {
    mine = new Map();
    loadedBy.set(sr, mine);
  }
  const paths = [
    ...new Set(
      Object.values(materials)
        .map((m) => m.map)
        .filter((p): p is string => !!p),
    ),
  ];
  await Promise.all(
    paths.map(async (path) => {
      const version = versions[path] ?? 0;
      let data = textureData.get(path);
      if (!data || data.version !== version) {
        try {
          const r = await host.request<{ mime: string; base64: string }>({ type: 'editor.readBinary', path });
          data = { version, url: `data:${r.mime};base64,${r.base64}` };
          textureData.set(path, data);
        } catch {
          return;
        }
      }
      if (mine.get(path) !== data.version || !sr.textures.has(path)) {
        sr.textures.add(path, data.url);
        mine.set(path, data.version);
      }
    }),
  );
  await sr.textures.ready();
}

/** True when any referenced texture file changed since it was loaded into `sr`. */
export function texturesStale(sr: SceneRenderer, materials: Record<string, MaterialDoc>): boolean {
  const versions = editor.get().fileVersions;
  const mine = loadedBy.get(sr);
  for (const m of Object.values(materials)) {
    if (m.map && (mine?.get(m.map) ?? -1) !== (versions[m.map] ?? 0)) return true;
  }
  return false;
}
