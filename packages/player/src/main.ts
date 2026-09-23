/**
 * AIGE web player: runs an exported game in the browser.
 * Game data (scenes, compiled scripts, baked models, textures) comes from game-data.js, which sets
 * window.__AIGE_GAME__. Works from file:// and any static host.
 */
import type { Entity, MaterialDoc, PrefabDoc, ProjectDoc, SceneDoc } from '@aige/core';
import { ModelCache, SceneRenderer } from '@aige/render';
import { api, type BehaviourClass, DomHud, DomInput, WebAudioBackend, World } from '@aige/runtime';
import { PCFSoftShadowMap, WebGLRenderer } from 'three';

export interface ExportedModelInfo {
  bounds: { min: number[]; max: number[]; size: number[]; center: number[] };
  collider: unknown;
}

export interface GameData {
  title: string;
  project: ProjectDoc;
  startScene: string;
  scenes: Record<string, SceneDoc>;
  prefabs: Record<string, PrefabDoc>;
  materials: Record<string, MaterialDoc>;
  /** scene path -> entity id -> model key */
  meshKeys: Record<string, Record<string, string>>;
  /** model path -> key for default params (used for entities spawned at runtime) */
  modelKeysByPath: Record<string, string>;
  modelInfos: Record<string, ExportedModelInfo>;
  /** model key -> base64 GLB */
  models: Record<string, string>;
  /** texture path -> base64 PNG */
  textures: Record<string, string>;
  /** script path -> compiled CommonJS source */
  scripts: Record<string, string>;
}

declare global {
  interface Window {
    __AIGE_GAME__?: GameData;
    __aigeRuntime?: unknown;
    /** Exposed for automated smoke tests. */
    __aigePlayer?: { world: World | null; frames: number; errors: string[] };
  }
}

const RUNTIME_GLOBAL = '__aigeRuntime';

function loadScripts(data: GameData, errors: string[]): Record<string, BehaviourClass> {
  (globalThis as Record<string, unknown>)[RUNTIME_GLOBAL] = api;
  const out: Record<string, BehaviourClass> = {};
  for (const [path, code] of Object.entries(data.scripts)) {
    try {
      const module = { exports: {} as Record<string, unknown> };
      // compiled user scripts are the game's own code
      new Function('module', 'exports', `${code}\n//# sourceURL=${path}`)(module, module.exports);
      out[path] = (module.exports.default ?? module.exports) as BehaviourClass;
    } catch (err) {
      errors.push(`${path}: ${(err as Error).message}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const data = window.__AIGE_GAME__;
  if (!data) throw new Error('game-data.js did not load');
  document.title = data.title;
  const status = { world: null as World | null, frames: 0, errors: [] as string[] };
  window.__aigePlayer = status;

  const container = document.getElementById('game') ?? document.body;
  const renderer = new WebGLRenderer({
    antialias: data.project.render.antialias,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.type = PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  const resize = () =>
    renderer.setSize(
      container.clientWidth || window.innerWidth,
      container.clientHeight || window.innerHeight,
    );
  window.addEventListener('resize', resize);
  resize();

  const models = new ModelCache();
  await Promise.all(Object.entries(data.models).map(([key, glb]) => models.add(key, glb)));
  const sr = new SceneRenderer(renderer, models);
  for (const [path, png] of Object.entries(data.textures)) sr.textures.add(path, png);
  await sr.textures.ready();

  const scripts = loadScripts(data, status.errors);
  const input = new DomInput({ target: renderer.domElement });
  const audio = new WebAudioBackend({ resolveUrl: (p: string) => p });
  const hud = new DomHud(container);
  const modelInfoForPath = (p: string) => {
    const key = data.modelKeysByPath[p];
    return key ? (data.modelInfos[key] as never) : undefined;
  };

  let world: World | null = null;
  let scenePath = data.startScene;
  const keyFor = (e: Entity): string | undefined => {
    const mr = e.components.find((c) => c.type === 'MeshRenderer');
    if (!mr?.model) return undefined;
    return data.meshKeys[scenePath]?.[e.id] ?? data.modelKeysByPath[mr.model as string];
  };
  const buildOpts = (doc: SceneDoc) => {
    const meshKeys: Record<string, string> = {};
    for (const e of doc.entities) {
      const k = keyFor(e);
      if (k) meshKeys[e.id] = k;
    }
    return { meshKeys, materials: data.materials, project: data.project };
  };
  const rebuildVisuals = async () => {
    if (!world) return;
    const doc = world.snapshotScene();
    await sr.build(doc, buildOpts(doc));
  };

  const start = async (path: string) => {
    world?.dispose();
    scenePath = path;
    const scene = data.scenes[path]!;
    const entityInfos: Record<string, never> = {};
    for (const e of scene.entities) {
      const k = keyFor(e);
      if (k && data.modelInfos[k]) entityInfos[e.id] = data.modelInfos[k] as never;
    }
    world = await World.create({
      project: data.project,
      scene,
      scenePath: path,
      scenes: data.scenes,
      prefabs: data.prefabs,
      scripts,
      models: entityInfos,
      modelInfoForPath,
      input,
      audio,
      seed: (Math.random() * 1e9) | 0,
    });
    status.world = world;
    world.on('error', (e: { message: string; script?: string }) =>
      status.errors.push(`${e.script ?? ''}: ${e.message}`),
    );
    await rebuildVisuals();
  };

  await start(data.startScene);

  // Click-to-start overlay (browsers only allow audio after a user gesture).
  const overlay = document.getElementById('start');
  if (overlay) {
    await new Promise<void>((resolve) => {
      const go = () => {
        overlay.remove();
        resolve();
      };
      overlay.addEventListener('click', go, { once: true });
      window.addEventListener('keydown', go, { once: true });
    });
  }
  (audio as unknown as { resume?: () => void }).resume?.();

  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'KeyR' && world?.gameOver) world.restart();
  });

  let last = performance.now();
  const frame = async (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (world) {
      world.update(dt);
      const changes = world.drainChanges();
      if (changes.sceneLoaded) await rebuildVisuals();
      else {
        for (const e of changes.spawned) {
          const doc = world.toEntityDoc(e);
          const k = keyFor(doc);
          await sr.addEntity(doc, {
            ...buildOpts({ ...world.scene, entities: [] }),
            meshKeys: k ? { [doc.id]: k } : {},
          });
        }
        for (const id of changes.destroyed) sr.removeEntity(id);
        for (const id of changes.components) {
          const ent = world.entities.get(id);
          if (!ent) continue;
          sr.removeEntity(id);
          const doc = world.toEntityDoc(ent);
          const k = keyFor(doc);
          await sr.addEntity(doc, {
            ...buildOpts({ ...world.scene, entities: [] }),
            meshKeys: k ? { [doc.id]: k } : {},
          });
        }
      }
      for (const [id, obj] of sr.objects) {
        const e = world.entities.get(id);
        if (!e) continue;
        obj.position.copy(e.position);
        obj.quaternion.copy(e.quaternion);
        obj.scale.copy(e.scale);
        obj.visible = e.active;
      }
      hud.update(world.hud, world.gameOver);
      const cam = sr.primaryCamera();
      if (cam) {
        const aspect = renderer.domElement.width / Math.max(1, renderer.domElement.height);
        if (Math.abs(cam.aspect - aspect) > 1e-3) {
          cam.aspect = aspect;
          cam.updateProjectionMatrix();
        }
        renderer.render(sr.scene, cam);
      }
      status.frames++;
    }
    requestAnimationFrame((t) => void frame(t));
  };
  requestAnimationFrame((t) => void frame(t));
}

main().catch((err) => {
  const pre = document.createElement('pre');
  pre.style.cssText =
    'color:#ff8080;background:#200;padding:16px;position:fixed;inset:auto 0 0 0;margin:0;white-space:pre-wrap';
  pre.textContent = `AIGE player error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  document.body.appendChild(pre);
  window.__aigePlayer?.errors.push(String(err));
});
