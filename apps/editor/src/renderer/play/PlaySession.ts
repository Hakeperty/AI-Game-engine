import type { Entity, ProjectState, SceneDoc } from '@aige/core';
import { type SceneBuildOptions, SceneRenderer } from '@aige/render';
import {
  DomHud,
  DomInput,
  type LogEntry,
  type ModelInfo,
  type ScriptError,
  WebAudioBackend,
  World,
} from '@aige/runtime';
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import type { ModelInfoLite } from '../../shared/protocol.ts';
import { host } from '../host/client.ts';
import { log } from '../store/editor.ts';
import { ensureTextures, modelCache, resolveModel } from '../three/assets.ts';
import { loadProjectScripts } from './scripts.ts';

const toRuntimeInfo = (info: ModelInfoLite): ModelInfo => ({
  bounds: info.bounds as unknown as ModelInfo['bounds'],
  collider: info.collider as ModelInfo['collider'],
});

function modelRef(e: Pick<Entity, 'components'>): { path: string; params: Record<string, unknown> } | null {
  const mr = e.components.find((c) => c.type === 'MeshRenderer');
  if (!mr?.model) return null;
  return { path: mr.model as string, params: (mr.params as Record<string, unknown>) ?? {} };
}

/**
 * Play mode: runs a @aige/runtime World on a copy of the current scene in the editor viewport
 * (same pattern as the web player): World.update -> drainChanges -> sync transforms -> render with
 * the game camera. DomInput, WebAudio and DomHud provide input, sound and the HUD.
 */
export class PlaySession {
  paused = false;
  private world: World | null = null;
  private readonly sr: SceneRenderer;
  private hud: DomHud | null = null;
  private state: ProjectState | null = null;
  private readonly keyByModel = new Map<string, string>();
  private rebuilding: Promise<void> | null = null;
  private disposed = false;
  private readonly offs: (() => void)[] = [];
  private readonly renderer: WebGLRenderer;
  private readonly container: HTMLElement;
  private readonly fallbackCamera: PerspectiveCamera;

  constructor(renderer: WebGLRenderer, container: HTMLElement, fallbackCamera: PerspectiveCamera) {
    this.renderer = renderer;
    this.container = container;
    this.fallbackCamera = fallbackCamera;
    this.sr = new SceneRenderer(renderer, modelCache);
  }

  private modelKey(e: Pick<Entity, 'components'>): string | undefined {
    const ref = modelRef(e);
    return ref ? this.keyByModel.get(`${ref.path}|${JSON.stringify(ref.params)}`) : undefined;
  }

  private buildOpts(entities: Pick<Entity, 'id' | 'components'>[]): SceneBuildOptions {
    const meshKeys: Record<string, string> = {};
    for (const e of entities) {
      const k = this.modelKey(e);
      if (k) meshKeys[e.id] = k;
    }
    return { meshKeys, materials: this.state?.materials ?? {}, project: this.state!.project };
  }

  async start(state: ProjectState): Promise<void> {
    this.state = state;
    const scenePath = state.activeScene;
    const scene = structuredClone(state.scenes[scenePath]) as SceneDoc;
    if (!scene) throw new Error('No scene is open.');

    // Resolve every model used by any scene or prefab (spawned entities and scene loads need them too).
    const refs = new Map<string, { path: string; params: Record<string, unknown> }>();
    const collect = (entities: Entity[]) => {
      for (const e of entities) {
        const r = modelRef(e);
        if (r) {
          refs.set(`${r.path}|${JSON.stringify(r.params)}`, r);
          refs.set(`${r.path}|{}`, { path: r.path, params: {} });
        }
      }
    };
    for (const s of Object.values(state.scenes)) collect(s.entities);
    for (const p of Object.values(state.prefabs)) collect(p.entities);
    const infoByKey = new Map<string, ModelInfoLite>();
    await Promise.all(
      [...refs].map(async ([id, r]) => {
        const res = await resolveModel(r.path, r.params);
        if (res) {
          this.keyByModel.set(id, res.key);
          infoByKey.set(res.key, res.info);
        }
      }),
    );
    const models: Record<string, ModelInfo> = {};
    for (const e of scene.entities) {
      const k = this.modelKey(e);
      const info = k ? infoByKey.get(k) : undefined;
      if (info) models[e.id] = toRuntimeInfo(info);
    }
    const modelInfoForPath = (path: string): ModelInfo | undefined => {
      const k = this.keyByModel.get(`${path}|{}`);
      const info = k ? infoByKey.get(k) : undefined;
      return info ? toRuntimeInfo(info) : undefined;
    };

    const { scripts, errors } = await loadProjectScripts();
    for (const e of errors) log('error', e, 'runtime');

    // Audio clips referenced by AudioSources are loaded as data: URLs (the renderer cannot read files).
    const clips = new Map<string, string>();
    const clipPaths = new Set<string>();
    for (const s of Object.values(state.scenes))
      for (const e of s.entities)
        for (const c of e.components) if (c.type === 'AudioSource' && c.clip) clipPaths.add(c.clip as string);
    await Promise.all(
      [...clipPaths].map(async (p) => {
        try {
          const r = await host.request<{ mime: string; base64: string }>({
            type: 'editor.readBinary',
            path: p,
          });
          clips.set(p, `data:${r.mime};base64,${r.base64}`);
        } catch {
          log('warn', `Audio clip '${p}' not found.`, 'runtime');
        }
      }),
    );

    await ensureTextures(this.sr, state.materials);
    if (this.disposed) return;

    const input = new DomInput({ target: this.renderer.domElement });
    const audio = new WebAudioBackend({ resolveUrl: (p) => clips.get(p) ?? p });
    this.hud = new DomHud(this.container);
    const world = await World.create({
      project: state.project,
      scene,
      scenePath,
      scenes: structuredClone(state.scenes) as Record<string, SceneDoc>,
      prefabs: state.prefabs,
      scripts,
      models,
      modelInfoForPath,
      input,
      audio,
      seed: (Math.random() * 1e9) | 0,
    });
    if (this.disposed) {
      world.dispose();
      return;
    }
    this.world = world;
    const onLog = (e: LogEntry) =>
      log(
        e.level,
        e.message,
        'runtime',
        e.script ? { detail: `${e.script}${e.entity ? ` on ${e.entity}` : ''}` } : {},
      );
    const onError = (e: ScriptError) =>
      log(
        'error',
        `${e.script}${e.entity ? ` on '${e.entity}'` : ''} (${e.hook}): ${e.message}`,
        'runtime',
        e.stack ? { detail: e.stack } : {},
      );
    // awake()/start() already ran inside World.create: replay what they printed.
    for (const e of world.startup.logs) onLog(e);
    for (const e of world.startup.errors) onError(e);
    this.offs.push(
      world.on('log', onLog),
      world.on('error', onError),
      world.on('game', (e) => {
        if (e.name === 'win' || e.name === 'lose')
          log('info', `Game ${e.name}${e.data ? `: ${JSON.stringify(e.data)}` : ''}`, 'runtime');
      }),
    );
    const onKey = (ev: KeyboardEvent) => {
      if (ev.code === 'KeyR' && this.world?.gameOver) this.world.restart();
    };
    window.addEventListener('keydown', onKey);
    this.offs.push(() => window.removeEventListener('keydown', onKey));
    await this.rebuild();
    log(
      'info',
      `Playing '${scene.name}'${Object.keys(scripts).length ? ` with ${Object.keys(scripts).length} script(s)` : ''}`,
      'runtime',
    );
  }

  private rebuild(): Promise<void> {
    const w = this.world;
    if (!w) return Promise.resolve();
    const run = (async () => {
      const doc = w.snapshotScene();
      await this.sr.build(doc, this.buildOpts(doc.entities));
    })();
    this.rebuilding = run.finally(() => {
      if (this.rebuilding === run) this.rebuilding = null;
    });
    return run;
  }

  private async addOrReplace(id: string, replace: boolean): Promise<void> {
    const w = this.world;
    const ent = w?.entities.get(id);
    if (!w || !ent) return;
    const doc = w.toEntityDoc(ent);
    if (replace) this.sr.removeEntity(id);
    await this.sr.addEntity(doc, this.buildOpts([doc]));
  }

  /** Advances the game one frame and renders it. */
  frame(dt: number): { triangles: number; calls: number } {
    const w = this.world;
    if (!w) return { triangles: 0, calls: 0 };
    if (!this.paused) w.update(dt);
    const changes = w.drainChanges();
    if (changes.sceneLoaded) void this.rebuild();
    else if (!this.rebuilding) {
      for (const e of changes.spawned) void this.addOrReplace(e.id, false);
      for (const id of changes.destroyed) this.sr.removeEntity(id);
      for (const id of changes.components) void this.addOrReplace(id, true);
    }
    for (const [id, obj] of this.sr.objects) {
      const e = w.entities.get(id);
      if (!e) continue;
      const parentId = e.parent?.id ?? null;
      const currentParent = (obj.parent?.userData.entityId as string | undefined) ?? null;
      if (parentId !== currentParent)
        (parentId ? this.sr.objects.get(parentId) : null)?.add(obj) ?? this.sr.scene.add(obj);
      obj.position.copy(e.position);
      obj.quaternion.copy(e.quaternion);
      obj.scale.copy(e.scale);
      obj.visible = e.active;
    }
    this.hud?.update(w.hud, w.gameOver);
    const canvas = this.renderer.domElement;
    const aspect = canvas.width / Math.max(1, canvas.height);
    const cam = this.sr.primaryCamera() ?? this.fallbackCamera;
    if (Math.abs(cam.aspect - aspect) > 1e-3) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    this.renderer.render(this.sr.scene, cam);
    return { triangles: this.renderer.info.render.triangles, calls: this.renderer.info.render.calls };
  }

  get sceneName(): string {
    return this.world?.sceneName ?? '';
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.offs.splice(0)) off();
    this.world?.dispose();
    this.world = null;
    this.hud?.root.remove();
    this.hud = null;
    this.sr.clear();
  }
}
