import { call, redo, run, undo } from './host/session.ts';
import { activeScene, editor, log, select, selectedEntity } from './store/editor.ts';
import { toast } from './ui/overlays.tsx';

/** Imperative hooks the scene viewport registers (focus, spawn point, play mode). */
export interface ViewportApi {
  focus(id?: string | null): void;
  /** Where new objects appear (in front of the scene camera, snapped to 0.5). */
  spawnPoint(): [number, number, number];
  startPlay(): Promise<void>;
  pausePlay(paused: boolean): void;
  stopPlay(): void;
}

let viewport: ViewportApi | null = null;
export function registerViewport(v: ViewportApi | null): void {
  viewport = v;
}
export function viewportApi(): ViewportApi | null {
  return viewport;
}

export type CreateKind =
  | 'empty'
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'capsule'
  | 'cone'
  | 'plane'
  | 'torus'
  | 'point-light'
  | 'directional-light'
  | 'spot-light'
  | 'hemisphere-light'
  | 'camera';

export const CREATE_LABELS: Record<CreateKind, string> = {
  empty: 'Empty',
  box: 'Cube',
  sphere: 'Sphere',
  cylinder: 'Cylinder',
  capsule: 'Capsule',
  cone: 'Cone',
  plane: 'Plane',
  torus: 'Torus',
  'point-light': 'Point Light',
  'directional-light': 'Directional Light',
  'spot-light': 'Spot Light',
  'hemisphere-light': 'Hemisphere Light',
  camera: 'Camera',
};

function preset(kind: CreateKind): {
  name: string;
  components: Record<string, unknown>[];
  rotation?: number[];
  lift: number;
} {
  const name = CREATE_LABELS[kind];
  switch (kind) {
    case 'empty':
      return { name, components: [], lift: 0 };
    case 'box':
      return {
        name,
        components: [
          { type: 'MeshRenderer', primitive: 'box' },
          { type: 'Collider', shape: 'box' },
        ],
        lift: 0.5,
      };
    case 'sphere':
      return {
        name,
        components: [
          { type: 'MeshRenderer', primitive: 'sphere' },
          { type: 'Collider', shape: 'sphere', radius: 0.5 },
        ],
        lift: 0.5,
      };
    case 'cylinder':
      return {
        name,
        components: [
          { type: 'MeshRenderer', primitive: 'cylinder' },
          { type: 'Collider', shape: 'cylinder', radius: 0.5, height: 1 },
        ],
        lift: 0.5,
      };
    case 'capsule':
      return {
        name,
        components: [
          { type: 'MeshRenderer', primitive: 'capsule' },
          { type: 'Collider', shape: 'capsule', radius: 0.5, height: 2 },
        ],
        lift: 1,
      };
    case 'cone':
      return {
        name,
        components: [
          { type: 'MeshRenderer', primitive: 'cone' },
          { type: 'Collider', shape: 'convex' },
        ],
        lift: 0.5,
      };
    case 'plane':
      return {
        name,
        components: [
          { type: 'MeshRenderer', primitive: 'plane' },
          { type: 'Collider', shape: 'box', size: [1, 0.02, 1] },
        ],
        lift: 0,
      };
    case 'torus':
      return {
        name,
        components: [
          { type: 'MeshRenderer', primitive: 'torus' },
          { type: 'Collider', shape: 'mesh' },
        ],
        lift: 0.15,
      };
    case 'point-light':
      return { name, components: [{ type: 'Light', kind: 'point', intensity: 1, range: 12 }], lift: 2 };
    case 'spot-light':
      return {
        name,
        components: [{ type: 'Light', kind: 'spot', intensity: 1.5, angle: 30 }],
        rotation: [-90, 0, 0],
        lift: 4,
      };
    case 'directional-light':
      return {
        name,
        components: [{ type: 'Light', kind: 'directional', intensity: 1.5 }],
        rotation: [-50, 30, 0],
        lift: 6,
      };
    case 'hemisphere-light':
      return { name, components: [{ type: 'Light', kind: 'hemisphere', intensity: 0.6 }], lift: 4 };
    case 'camera':
      return { name, components: [{ type: 'Camera', primary: false }], lift: 2 };
  }
}

/** Creates an entity from the Create menu and selects it. */
export async function createEntity(kind: CreateKind, parent?: string | null): Promise<string | null> {
  const p = preset(kind);
  const spawn = viewport?.spawnPoint() ?? [0, 0, 0];
  const input: Record<string, unknown> = { name: p.name, components: p.components };
  if (parent) input.parent = parent;
  else input.position = [spawn[0], Math.max(spawn[1], 0) + p.lift, spawn[2]];
  if (p.rotation) input.rotation = p.rotation;
  const res = await run<{ id: string }>('entity_create', input);
  if (res) select(res.id);
  return res?.id ?? null;
}

/** Creates an entity that renders a model asset (drag and drop from the Project panel). */
export async function createModelEntity(
  model: string,
  opts: { parent?: string | null; position?: number[] } = {},
): Promise<void> {
  const name = (model.split('/').pop() ?? 'Model').replace(/\.model\.ts$|\.glb$/, '');
  const input: Record<string, unknown> = {
    name: name.charAt(0).toUpperCase() + name.slice(1),
    components: [
      { type: 'MeshRenderer', model },
      { type: 'Collider', shape: 'auto' },
    ],
  };
  if (opts.parent) input.parent = opts.parent;
  if (opts.position) input.position = opts.position;
  else if (!opts.parent) input.position = viewport?.spawnPoint() ?? [0, 0, 0];
  const res = await run<{ id: string }>('entity_create', input);
  if (res) select(res.id);
}

export async function deleteSelected(): Promise<void> {
  const e = selectedEntity(editor.get());
  if (!e) return;
  const res = await run('entity_delete', { entity: e.id });
  if (res) select(null);
}

export async function duplicateSelected(): Promise<void> {
  const e = selectedEntity(editor.get());
  if (!e) return;
  const res = await run<{ created: { id: string }[] }>('entity_duplicate', {
    entity: e.id,
    count: 1,
    offset: [0, 0, 0],
  });
  const id = res?.created[0]?.id;
  if (id) select(id);
}

export function focusSelection(): void {
  viewport?.focus(editor.get().selection);
}

export async function togglePlay(): Promise<void> {
  const s = editor.get();
  if (s.play === 'edit') {
    if (!viewport) {
      toast('Open the Scene view to play the game.', 'error');
      return;
    }
    try {
      await viewport.startPlay();
    } catch (err) {
      log('error', `Play mode failed: ${(err as Error).message}`, 'runtime');
      editor.set({ play: 'edit' });
    }
  } else viewport?.stopPlay();
}

export function togglePause(): void {
  const s = editor.get();
  if (s.play === 'edit') return;
  viewport?.pausePlay(s.play === 'playing');
}

export function stopPlay(): void {
  if (editor.get().play !== 'edit') viewport?.stopPlay();
}

export { redo, undo };

/** Undo the last AI turn (the agent wraps each run in one transaction labelled 'AI: ...'). */
export async function undoAiTurn(): Promise<void> {
  const label = editor.get().history.undoLabel ?? '';
  if (!label.startsWith('AI:')) {
    toast('The last change was not made by the AI.', 'error');
    return;
  }
  const r = await call('undo', { steps: 1 });
  if (r.ok) toast(`Undid "${label}"`, 'ok');
}

export function hasProjectScene(): boolean {
  return !!activeScene(editor.get());
}
