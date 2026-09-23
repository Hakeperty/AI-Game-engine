import type { Entity, MaterialDoc, ProjectState, SceneDoc } from '@aige/core';
import { applyTransform, type SceneBuildOptions, SceneRenderer } from '@aige/render';
import {
  Box3,
  Box3Helper,
  type BufferGeometry,
  Color,
  type LineBasicMaterial,
  MathUtils,
  type Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { run } from '../host/session.ts';
import type { PlaySession } from '../play/PlaySession.ts';
import { editor, log, useEditor } from '../store/editor.ts';
import {
  ensureTextures,
  modelCache,
  modelGeneration,
  onModelsInvalidated,
  resolveModel,
  texturesStale,
} from '../three/assets.ts';
import { addGizmos } from './gizmos.ts';
import { EditorGrid } from './grid.ts';

export interface ViewportStats {
  fps: number;
  triangles: number;
  calls: number;
  scene: string;
  playing: boolean;
}

const DEG = MathUtils.RAD2DEG;
const round = (n: number, d = 4) => {
  const r = Number(n.toFixed(d));
  return Object.is(r, -0) ? 0 : r;
};

function isVisible(o: Object3D | null): boolean {
  let cur = o;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

function modelOf(e: Entity): { path: string; params: Record<string, unknown> } | null {
  const mr = e.components.find((c) => c.type === 'MeshRenderer');
  return mr?.model
    ? { path: mr.model as string, params: (mr.params as Record<string, unknown>) ?? {} }
    : null;
}

/** Parents before children (entities may be listed in any order after reparenting). */
function parentFirst(entities: Entity[]): Entity[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const out: Entity[] = [];
  const seen = new Set<string>();
  const visit = (e: Entity, depth = 0) => {
    if (seen.has(e.id) || depth > 1000) return;
    if (e.parent && byId.has(e.parent)) visit(byId.get(e.parent)!, depth + 1);
    seen.add(e.id);
    out.push(e);
  };
  for (const e of entities) visit(e);
  return out;
}

/**
 * The scene view: SceneRenderer + orbit camera + transform gizmo, kept in sync with the store's replica.
 * Transform/active-only changes update objects in place; component changes rebuild just that entity;
 * settings, material or scene switches rebuild everything.
 */
export class EditorViewport {
  readonly renderer: WebGLRenderer;
  readonly sr: SceneRenderer;
  readonly camera = new PerspectiveCamera(50, 1, 0.05, 4000);
  readonly orbit: OrbitControls;
  readonly gizmo: TransformControls;
  private readonly overlay = new Scene();
  private readonly grid = new EditorGrid();
  private readonly selectionBox = new Box3Helper(new Box3(), new Color('#f2a33a'));
  private readonly container: HTMLElement;
  private readonly raycaster = new Raycaster();
  private lastState: ProjectState | null = null;
  private lastScene: SceneDoc | null = null;
  private lastModelGen = -1;
  private syncing = false;
  private syncQueued = false;
  private framed = false;
  private disposed = false;
  private raf = 0;
  private lastTime = performance.now();
  private frames = 0;
  private fpsTime = performance.now();
  private fps = 0;
  private selectedId: string | null = null;
  private gizmoDragged = false;
  private focusAnim: { from: Vector3; to: Vector3; fromT: Vector3; toT: Vector3; t0: number } | null = null;
  private play: PlaySession | null = null;
  private visible = true;
  private readonly offs: (() => void)[] = [];
  onStats: ((s: ViewportStats) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.domElement.className = 'viewport-canvas';
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);
    this.sr = new SceneRenderer(this.renderer, modelCache);

    this.camera.position.set(9, 7, 11);
    // TransformControls first, so its pointerdown disables orbiting before OrbitControls sees it.
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.9);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.18;
    this.orbit.screenSpacePanning = true;
    this.orbit.target.set(0, 0, 0);
    this.orbit.update();
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      this.orbit.enabled = !dragging;
      if (dragging) this.gizmoDragged = true;
      else void this.commitGizmo();
    });
    this.overlay.add(this.gizmo.getHelper());
    this.buildGrid();
    (this.selectionBox.material as LineBasicMaterial).depthTest = false;
    (this.selectionBox.material as LineBasicMaterial).toneMapped = false;
    this.selectionBox.visible = false;
    this.overlay.add(this.selectionBox);

    this.bindPointer();
    this.applyToolState();
    this.offs.push(
      useEditor.subscribe((s, prev) => {
        if (s.state !== prev.state) this.scheduleSync();
        if (s.selection !== prev.selection) this.setSelection(s.selection);
        if (s.tool !== prev.tool || s.space !== prev.space || s.snap !== prev.snap) this.applyToolState();
      }),
      onModelsInvalidated(() => this.scheduleSync()),
    );
    this.scheduleSync();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------------ helpers & grid

  private buildGrid(): void {
    this.overlay.add(this.grid);
  }

  private applyToolState(): void {
    const s = editor.get();
    this.gizmo.setMode(s.tool);
    this.gizmo.setSpace(s.tool === 'scale' ? 'local' : s.space);
    this.gizmo.setTranslationSnap(s.snap ? 0.5 : null);
    this.gizmo.setRotationSnap(s.snap ? MathUtils.degToRad(15) : null);
    this.gizmo.setScaleSnap(s.snap ? 0.1 : null);
  }

  // ------------------------------------------------------------------ scene sync

  scheduleSync(): void {
    if (this.syncing) {
      this.syncQueued = true;
      return;
    }
    this.syncing = true;
    void this.syncLoop();
  }

  private async syncLoop(): Promise<void> {
    try {
      do {
        this.syncQueued = false;
        await this.syncOnce();
      } while (this.syncQueued && !this.disposed);
    } catch (err) {
      log('error', `Viewport update failed: ${(err as Error).message}`);
    } finally {
      this.syncing = false;
    }
  }

  private buildOptions(state: ProjectState, meshKeys: Record<string, string>): SceneBuildOptions {
    return { meshKeys, materials: state.materials, project: state.project };
  }

  private async meshKeysFor(entities: Entity[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    await Promise.all(
      entities.map(async (e) => {
        const m = modelOf(e);
        if (!m) return;
        const r = await resolveModel(m.path, m.params);
        if (r) out[e.id] = r.key;
      }),
    );
    return out;
  }

  private async syncOnce(): Promise<void> {
    if (this.play) return;
    const state = editor.get().state;
    const scene = state ? (state.scenes[state.activeScene] ?? null) : null;
    if (!state || !scene) {
      this.sr.clear();
      this.lastState = null;
      this.lastScene = null;
      return;
    }
    const prevState = this.lastState;
    const prevScene = this.lastScene;
    const gen = modelGeneration();
    const modelsChanged = gen !== this.lastModelGen;
    const full =
      !prevState ||
      !prevScene ||
      state.activeScene !== prevState.activeScene ||
      scene.settings !== prevScene.settings ||
      state.materials !== prevState.materials ||
      state.project.render !== prevState.project.render ||
      texturesStale(this.sr, state.materials);

    if (full) {
      await ensureTextures(this.sr, state.materials as Record<string, MaterialDoc>);
      const meshKeys = await this.meshKeysFor(scene.entities);
      await this.sr.build(scene, this.buildOptions(state, meshKeys));
      for (const e of scene.entities) {
        const obj = this.sr.objects.get(e.id);
        if (obj) addGizmos(obj, e, e.id === this.selectedId);
      }
      if (!this.framed || state.activeScene !== prevState?.activeScene) {
        this.frameScene(scene);
        this.framed = true;
      }
    } else {
      await this.syncIncremental(state, prevScene, scene, modelsChanged);
    }
    this.lastState = state;
    this.lastScene = scene;
    this.lastModelGen = gen;
    this.setSelection(editor.get().selection, true);
  }

  private async syncIncremental(
    state: ProjectState,
    prev: SceneDoc,
    next: SceneDoc,
    modelsChanged: boolean,
  ): Promise<void> {
    if (prev === next && !modelsChanged) return;
    const prevById = new Map(prev.entities.map((e) => [e.id, e]));
    const nextById = new Map(next.entities.map((e) => [e.id, e]));
    let structural = false;
    // Removed entities (keep surviving children; they are reparented below).
    for (const [id] of prevById) {
      if (nextById.has(id)) continue;
      const obj = this.sr.objects.get(id);
      if (!obj) continue;
      for (const c of [...obj.children]) {
        const cid = c.userData.entityId as string | undefined;
        if (cid && nextById.has(cid)) this.sr.scene.add(c);
      }
      this.sr.removeEntity(id);
      structural = true;
    }
    const rebuild: Entity[] = [];
    for (const e of parentFirst(next.entities)) {
      const p = prevById.get(e.id);
      const needsBuild =
        !p || p.components !== e.components || !this.sr.objects.has(e.id) || (modelsChanged && !!modelOf(e));
      if (needsBuild) {
        rebuild.push(e);
        continue;
      }
      if (p === e) continue;
      const obj = this.sr.objects.get(e.id)!;
      if (p.parent !== e.parent) {
        const parentObj = e.parent ? this.sr.objects.get(e.parent) : undefined;
        (parentObj ?? this.sr.scene).add(obj);
        structural = true;
      }
      applyTransform(obj, e);
      obj.visible = e.active;
      obj.name = e.name;
      obj.userData.tags = e.tags;
      if (p.transform !== e.transform || p.active !== e.active) structural = true;
    }
    if (rebuild.length) {
      const meshKeys = await this.meshKeysFor(rebuild);
      const opts = this.buildOptions(state, meshKeys);
      for (const e of rebuild) {
        const old = this.sr.objects.get(e.id);
        const kids = old
          ? old.children.filter((c) => !!c.userData.entityId && c.userData.entityId !== e.id)
          : [];
        const obj = await this.sr.addEntity(e, opts);
        for (const k of kids) obj.add(k);
        if (old && old !== obj) old.removeFromParent();
        addGizmos(obj, e, e.id === this.selectedId);
      }
      structural = true;
    }
    if (structural) this.sr.fitShadows();
  }

  // ------------------------------------------------------------------ selection & gizmo

  private setSelection(id: string | null, force = false): void {
    if (id === this.selectedId && !force) return;
    const prev = this.selectedId;
    this.selectedId = id;
    const scene = this.lastScene;
    // Re-tint icon gizmos of the previously / newly selected entity.
    for (const eid of [prev, id]) {
      if (!eid || !scene) continue;
      const e = scene.entities.find((x) => x.id === eid);
      const obj = this.sr.objects.get(eid);
      if (e && obj) addGizmos(obj, e, eid === id);
    }
    const obj = id ? this.sr.objects.get(id) : undefined;
    if (obj && !this.play) {
      if (this.gizmo.object !== obj) this.gizmo.attach(obj);
    } else if (this.gizmo.object) this.gizmo.detach();
  }

  private async commitGizmo(): Promise<void> {
    const obj = this.gizmo.object;
    const id = obj?.userData.entityId as string | undefined;
    const e = id ? this.lastScene?.entities.find((x) => x.id === id) : undefined;
    if (!obj || !id || !e) return;
    const position = [round(obj.position.x), round(obj.position.y), round(obj.position.z)];
    const rotation = [
      round(obj.rotation.x * DEG, 3),
      round(obj.rotation.y * DEG, 3),
      round(obj.rotation.z * DEG, 3),
    ];
    const scale = [round(obj.scale.x), round(obj.scale.y), round(obj.scale.z)];
    const same = (a: readonly number[], b: readonly number[]) =>
      a.every((v, i) => Math.abs(v - (b[i] ?? 0)) < 1e-4);
    const input: Record<string, unknown> = { entity: id };
    if (!same(position, e.transform.position)) input.position = position;
    if (!same(rotation, e.transform.rotation)) input.rotation = rotation;
    if (!same(scale, e.transform.scale)) input.scale = scale;
    if (Object.keys(input).length === 1) return;
    const res = await run('entity_update', input);
    if (!res) applyTransform(obj, e);
  }

  /** Live preview while scrubbing inspector fields (committed separately through entity_update). */
  previewTransform(id: string, t: Partial<Entity['transform']>): void {
    const obj = this.sr.objects.get(id);
    const e = this.lastScene?.entities.find((x) => x.id === id);
    if (!obj || !e) return;
    applyTransform(obj, { transform: { ...e.transform, ...t } });
  }

  // ------------------------------------------------------------------ camera

  private frameScene(scene: SceneDoc): void {
    const interesting = scene.entities
      .filter(
        (e) =>
          e.active &&
          !e.tags.includes('Ground') &&
          e.name !== 'Ground' &&
          e.components.some((c) => c.type === 'MeshRenderer'),
      )
      .map((e) => e.id);
    // Only a ground plane (or nothing): look at a comfortable 12 m area around the origin.
    let box = interesting.length ? this.sr.renderableBounds(interesting) : new Box3();
    if (box.isEmpty()) box = new Box3(new Vector3(-5, 0, -5), new Vector3(5, 1.5, 5));
    const center = box.getCenter(new Vector3());
    const radius = Math.max(2.5, box.getSize(new Vector3()).length() / 2);
    const dir = new Vector3(0.62, 0.52, 0.82).normalize();
    const dist = (radius / Math.sin(MathUtils.degToRad(this.camera.fov) / 2)) * 1.05;
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.orbit.update();
  }

  focus(id: string | null = this.selectedId): void {
    if (!id) {
      if (this.lastScene) this.frameScene(this.lastScene);
      return;
    }
    const obj = this.sr.objects.get(id);
    if (!obj) return;
    let box = this.sr.renderableBounds([id]);
    if (box.isEmpty()) {
      const p = obj.getWorldPosition(new Vector3());
      box = new Box3(p.clone().subScalar(0.75), p.clone().addScalar(0.75));
    }
    const center = box.getCenter(new Vector3());
    const radius = Math.max(0.5, box.getSize(new Vector3()).length() / 2);
    const dist = (radius / Math.sin(MathUtils.degToRad(this.camera.fov) / 2)) * 1.15;
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.focusAnim = {
      from: this.camera.position.clone(),
      to: center.clone().addScaledVector(dir, dist),
      fromT: this.orbit.target.clone(),
      toT: center,
      t0: performance.now(),
    };
  }

  spawnPoint(): [number, number, number] {
    const t = this.orbit.target;
    return [Math.round(t.x * 2) / 2, Math.max(0, Math.round(t.y * 2) / 2), Math.round(t.z * 2) / 2];
  }

  /** World point under the cursor (scene meshes first, then the ground plane y=0). */
  pointAt(clientX: number, clientY: number): [number, number, number] | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.sr.scene.children, true);
    for (const h of hits) {
      if (h.object.userData.noPick || h.object.userData.editorGizmo || !isVisible(h.object)) continue;
      if ((h.object as { isSprite?: boolean }).isSprite) continue;
      return [round(h.point.x, 2), round(h.point.y, 2), round(h.point.z, 2)];
    }
    const p = new Vector3();
    if (this.raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), p))
      return [round(p.x, 2), 0, round(p.z, 2)];
    return null;
  }

  private pick(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.sr.scene.children, true);
    // Icon sprites win over meshes behind them.
    hits.sort(
      (a, b) =>
        Number(!!(b.object as { isSprite?: boolean }).isSprite) -
          Number(!!(a.object as { isSprite?: boolean }).isSprite) || a.distance - b.distance,
    );
    for (const h of hits) {
      if (h.object.userData.noPick || !isVisible(h.object)) continue;
      let o: Object3D | null = h.object;
      while (o && !o.userData.entityId) o = o.parent;
      if (o) return o.userData.entityId as string;
    }
    return null;
  }

  private bindPointer(): void {
    const el = this.renderer.domElement;
    let down: { x: number; y: number; button: number } | null = null;
    const onDown = (e: PointerEvent) => {
      el.focus();
      down = { x: e.clientX, y: e.clientY, button: e.button };
      this.gizmoDragged = false;
    };
    const onUp = (e: PointerEvent) => {
      if (!down || this.play) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const wasGizmo = this.gizmoDragged;
      const button = down.button;
      down = null;
      if (moved > 4 || wasGizmo || button !== 0) return;
      if ((this.gizmo as unknown as { axis: string | null }).axis) return;
      editor.set({ selection: this.pick(e.clientX, e.clientY) });
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.offs.push(() => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
    });
  }

  // ------------------------------------------------------------------ play mode

  async startPlay(): Promise<void> {
    if (this.play) return;
    const state = editor.get().state;
    if (!state) throw new Error('No project is open.');
    const { PlaySession } = await import('../play/PlaySession.ts');
    const session = new PlaySession(this.renderer, this.container, this.camera);
    this.gizmo.detach();
    this.play = session;
    editor.set({ play: 'playing' });
    try {
      await session.start(state);
    } catch (err) {
      session.dispose();
      this.play = null;
      editor.set({ play: 'edit' });
      this.setSelection(editor.get().selection, true);
      throw err;
    }
  }

  pausePlay(paused: boolean): void {
    if (!this.play) return;
    this.play.paused = paused;
    editor.set({ play: paused ? 'paused' : 'playing' });
  }

  stopPlay(): void {
    if (!this.play) return;
    this.play.dispose();
    this.play = null;
    editor.set({ play: 'edit' });
    // Rebuild the editor scene (play mode changed renderer settings) and restore the gizmo.
    this.lastState = null;
    this.scheduleSync();
    log('info', 'Stopped playing; the scene is unchanged.', 'runtime');
  }

  get playing(): boolean {
    return !!this.play;
  }

  // ------------------------------------------------------------------ loop

  setVisible(v: boolean): void {
    this.visible = v;
  }

  private resize(): boolean {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const canvas = this.renderer.domElement;
    const pr = this.renderer.getPixelRatio();
    if (canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) {
      this.renderer.setSize(w, h, false);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    return w > 1 && h > 1;
  }

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    if (!this.visible || document.hidden || !this.container.isConnected || !this.resize()) return;
    let triangles = 0;
    let calls = 0;
    if (this.play) {
      const r = this.play.frame(dt);
      triangles = r.triangles;
      calls = r.calls;
    } else {
      if (this.focusAnim) {
        const k = Math.min(1, (now - this.focusAnim.t0) / 220);
        const ease = 1 - (1 - k) ** 3;
        this.camera.position.lerpVectors(this.focusAnim.from, this.focusAnim.to, ease);
        this.orbit.target.lerpVectors(this.focusAnim.fromT, this.focusAnim.toT, ease);
        if (k >= 1) this.focusAnim = null;
      }
      this.orbit.update();
      this.grid.update(this.camera, this.orbit.target);
      this.updateSelectionBox();
      this.renderer.autoClear = true;
      this.renderer.render(this.sr.scene, this.camera);
      triangles = this.renderer.info.render.triangles;
      calls = this.renderer.info.render.calls;
      this.renderer.autoClear = false;
      this.renderer.render(this.overlay, this.camera);
      this.renderer.autoClear = true;
    }
    this.frames++;
    if (now - this.fpsTime > 500) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsTime));
      this.frames = 0;
      this.fpsTime = now;
      this.onStats?.({
        fps: this.fps,
        triangles,
        calls,
        scene: this.play ? this.play.sceneName : (this.lastScene?.name ?? ''),
        playing: !!this.play,
      });
    }
  };

  private updateSelectionBox(): void {
    const id = this.selectedId;
    const obj = id ? this.sr.objects.get(id) : undefined;
    if (!obj || !isVisible(obj)) {
      this.selectionBox.visible = false;
      return;
    }
    const box = this.selectionBox.box;
    box.makeEmpty();
    obj.updateWorldMatrix(true, true);
    obj.traverse((o) => {
      const mesh = o as { isMesh?: boolean; geometry?: BufferGeometry };
      if (!mesh.isMesh || !mesh.geometry || o.userData.editorGizmo || !isVisible(o)) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(o.matrixWorld));
    });
    this.selectionBox.visible = !box.isEmpty();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.play?.dispose();
    this.play = null;
    for (const off of this.offs.splice(0)) off();
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.sr.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
