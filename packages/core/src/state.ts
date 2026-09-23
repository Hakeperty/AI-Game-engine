import { AigeError, didYouMean } from './errors.ts';
import type { CutsceneDoc, Entity, MaterialDoc, PrefabDoc, ProjectDoc, SceneDoc } from './schema/documents.ts';
import { createProjectDoc, createSceneDoc } from './schema/documents.ts';

/**
 * The in-memory project document. Everything in here is plain JSON and is mutated only through
 * commands (immer drafts), which is what makes undo/redo, replay and live replicas possible.
 * Text assets (scripts, model recipes) live on disk and are versioned by the command bus separately.
 */
export interface ProjectState {
  project: ProjectDoc;
  /** Keyed by project-relative path, e.g. 'scenes/main.scene.json'. */
  scenes: Record<string, SceneDoc>;
  materials: Record<string, MaterialDoc>;
  prefabs: Record<string, PrefabDoc>;
  /** Keyed by path, e.g. 'cutscenes/intro.cutscene.json'. */
  cutscenes: Record<string, CutsceneDoc>;
  activeScene: string;
}

export function createProjectState(name: string): ProjectState {
  const scenePath = 'scenes/main.scene.json';
  return {
    project: createProjectDoc(name, scenePath),
    scenes: { [scenePath]: createSceneDoc('main') },
    materials: {},
    prefabs: {},
    cutscenes: {},
    activeScene: scenePath,
  };
}

// ---------------------------------------------------------------------------------------------
// Scene lookup helpers (work on both plain objects and immer drafts)
// ---------------------------------------------------------------------------------------------

export function getScene(state: ProjectState, scene?: string): SceneDoc {
  const path = resolveScenePath(state, scene);
  return state.scenes[path]!;
}

export function resolveScenePath(state: ProjectState, scene?: string): string {
  if (!scene) {
    if (!state.scenes[state.activeScene]) {
      throw new AigeError('INVALID_STATE', 'No scene is open.', { hint: 'Create one with scene_create.' });
    }
    return state.activeScene;
  }
  const norm = scene.replaceAll('\\', '/');
  if (state.scenes[norm]) return norm;
  // Accept bare names: 'level1' -> 'scenes/level1.scene.json'
  for (const [path, doc] of Object.entries(state.scenes)) {
    if (doc.name === scene || path === `scenes/${scene}.scene.json`) return path;
  }
  throw new AigeError('NOT_FOUND', `Scene '${scene}' not found.`, {
    hint: didYouMean(scene, Object.keys(state.scenes)) ?? `Scenes: ${Object.keys(state.scenes).join(', ')}`,
  });
}

export function entityIndex(scene: SceneDoc): Map<string, Entity> {
  return new Map(scene.entities.map((e) => [e.id, e]));
}

export function childrenOf(scene: SceneDoc, id: string | null): Entity[] {
  return scene.entities.filter((e) => e.parent === id);
}

/** 'Level/Platforms/P3' style path built from names. */
export function entityPath(scene: SceneDoc, entity: Entity, index = entityIndex(scene)): string {
  const parts: string[] = [];
  let cur: Entity | undefined = entity;
  let guard = 0;
  while (cur && guard++ < 1000) {
    parts.unshift(cur.name);
    cur = cur.parent ? index.get(cur.parent) : undefined;
  }
  return parts.join('/');
}

/**
 * Resolves an entity reference: exact id, then name path ('A/B/C'), then unique name.
 * Throws NOT_FOUND / AMBIGUOUS with suggestions.
 */
export function resolveEntity(scene: SceneDoc, ref: string): Entity {
  const byId = scene.entities.find((e) => e.id === ref);
  if (byId) return byId;
  const index = entityIndex(scene);
  if (ref.includes('/')) {
    const match = scene.entities.filter((e) => entityPath(scene, e, index) === ref);
    if (match.length === 1) return match[0]!;
  }
  const byName = scene.entities.filter((e) => e.name === ref);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new AigeError('AMBIGUOUS', `${byName.length} entities are named '${ref}'.`, {
      hint: `Use an id or a path instead: ${byName
        .slice(0, 5)
        .map((e) => `${e.id} (${entityPath(scene, e, index)})`)
        .join(', ')}`,
    });
  }
  const candidates = scene.entities.flatMap((e) => [e.name, e.id]);
  throw new AigeError('NOT_FOUND', `Entity '${ref}' not found in scene '${scene.name}'.`, {
    hint: didYouMean(ref, candidates) ?? 'Use scene_tree to list entities.',
  });
}

/** The entity and all of its descendants (entity first, depth-first order). */
export function subtree(scene: SceneDoc, rootId: string): Entity[] {
  const out: Entity[] = [];
  const byParent = new Map<string | null, Entity[]>();
  for (const e of scene.entities) {
    const list = byParent.get(e.parent) ?? [];
    list.push(e);
    byParent.set(e.parent, list);
  }
  const visit = (id: string) => {
    const e = scene.entities.find((x) => x.id === id);
    if (!e) return;
    out.push(e);
    for (const c of byParent.get(id) ?? []) visit(c.id);
  };
  visit(rootId);
  return out;
}

export function isDescendant(scene: SceneDoc, id: string, ancestorId: string): boolean {
  const index = entityIndex(scene);
  let cur = index.get(id);
  let guard = 0;
  while (cur?.parent && guard++ < 10000) {
    if (cur.parent === ancestorId) return true;
    cur = index.get(cur.parent);
  }
  return false;
}

/** Allocates the next id ('e1', 'e2', ...) from the scene counter. Call on a draft. */
export function allocateEntityId(scene: SceneDoc): string {
  let id = `e${scene.nextId++}`;
  while (scene.entities.some((e) => e.id === id)) id = `e${scene.nextId++}`;
  return id;
}

/** Makes `name` unique among siblings by appending ' (2)', ' (3)', ... only when needed. */
export function uniqueSiblingName(
  scene: SceneDoc,
  parent: string | null,
  name: string,
  exceptId?: string,
): string {
  const taken = new Set(
    scene.entities.filter((e) => e.parent === parent && e.id !== exceptId).map((e) => e.name),
  );
  if (!taken.has(name)) return name;
  const base = name.replace(/ \(\d+\)$/, '');
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}
