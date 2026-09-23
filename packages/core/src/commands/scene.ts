import type { Draft } from 'immer';
import { z } from 'zod';
import { AigeError } from '../errors.ts';
import { definedOnly, EulerDeg, patchOf, Vec3 } from '../schema/common.ts';
import {
  type ComponentData,
  getComponentDef,
  listComponentDefs,
  parseComponent,
  parseComponentPatch,
} from '../schema/components.ts';
import { createSceneDoc, type Entity, type SceneDoc, SceneSettings } from '../schema/documents.ts';
import {
  allocateEntityId,
  childrenOf,
  entityIndex,
  entityPath,
  getScene,
  isDescendant,
  type ProjectState,
  resolveEntity,
  resolveScenePath,
  subtree,
  uniqueSiblingName,
} from '../state.ts';
import { signature } from '../tools.ts';
import { localFromWorld, worldMatrix, worldTransform } from '../transform.ts';
import { defineCommand } from './define.ts';

// ---------------------------------------------------------------------------------------------
// Shared input pieces
// ---------------------------------------------------------------------------------------------

const SceneRef = z.string().optional().describe('Scene path or name; defaults to the open scene');
const EntityRef = z.string().min(1).describe("Entity id ('e12'), path ('Level/Platform 3') or unique name");
const Scale = z
  .union([z.number(), Vec3])
  .transform((v): [number, number, number] => (typeof v === 'number' ? [v, v, v] : v))
  .describe('Uniform number or [x, y, z]');

const componentTypes = () => listComponentDefs().map((d) => d.type);

const ComponentInput = z
  .object({ type: z.string().describe(`Component type: ${componentTypes().join(', ')}`) })
  .loose()
  .describe('Component: { type, ...properties }. See the component reference for properties.');

/** Compact list of every component and its properties, embedded in tool descriptions. */
export function componentReference(): string {
  return listComponentDefs()
    .map(
      (d) =>
        `- ${d.type}${d.multiple ? ' (multiple allowed)' : ''}: ${d.description}\n  ${signature(d.schema)}`,
    )
    .join('\n');
}

function sceneDraft(draft: Draft<ProjectState>, scene?: string): Draft<SceneDoc> {
  return draft.scenes[resolveScenePath(draft as ProjectState, scene)]!;
}

function findDraftEntity(scene: Draft<SceneDoc>, id: string): Draft<Entity> {
  const e = scene.entities.find((x) => x.id === id);
  if (!e) throw new AigeError('NOT_FOUND', `Entity '${id}' not found.`);
  return e;
}

function componentSummary(c: ComponentData): string {
  const detail =
    c.primitive ??
    (c.model as string | undefined)?.split('/').pop() ??
    c.kind ??
    c.shape ??
    c.script ??
    c.sfx;
  return detail ? `${c.type} ${detail}` : c.type;
}

const fmt = (v: readonly number[]) => v.map((n) => Math.round(n * 1000) / 1000).join(',');

function describeEntity(scene: SceneDoc, e: Entity, index = entityIndex(scene)) {
  return {
    id: e.id,
    name: e.name,
    path: entityPath(scene, e, index),
    parent: e.parent,
    active: e.active,
    tags: e.tags,
    transform: e.transform,
    worldPosition: worldTransform(scene, e, index).position,
    components: e.components,
    children: childrenOf(scene, e.id).map((c) => c.id),
    ...(e.prefab ? { prefab: e.prefab } : {}),
  };
}

function checkComponentAllowed(entity: Entity, comp: ComponentData, exceptIndex = -1) {
  const def = getComponentDef(comp.type);
  if (def.multiple) return;
  const dup = entity.components.some((c, i) => c.type === comp.type && i !== exceptIndex);
  if (dup) {
    throw new AigeError('CONFLICT', `Entity '${entity.name}' already has a ${comp.type}.`, {
      hint: `Use component_update to change it, or component_remove first.`,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------------------------

export const sceneList = defineCommand({
  name: 'scene_list',
  group: 'scene',
  kind: 'query',
  tier: 'extended',
  description: 'List all scenes in the project and which one is open.',
  input: z.object({}).strict(),
  run(ctx) {
    const s = ctx.state;
    return {
      active: s.activeScene,
      startScene: s.project.startScene,
      scenes: Object.entries(s.scenes).map(([path, doc]) => ({
        path,
        name: doc.name,
        entities: doc.entities.length,
      })),
    };
  },
});

export function basicSceneEntities(): Omit<Entity, 'id'>[] {
  return [
    {
      name: 'Main Camera',
      parent: null,
      active: true,
      tags: ['MainCamera'],
      transform: { position: [0, 6, 12], rotation: [-22, 0, 0], scale: [1, 1, 1] },
      components: [parseComponent({ type: 'Camera' })],
    },
    {
      name: 'Sun',
      parent: null,
      active: true,
      tags: [],
      transform: { position: [0, 10, 0], rotation: [-50, 30, 0], scale: [1, 1, 1] },
      components: [parseComponent({ type: 'Light', kind: 'directional', intensity: 2.2, castShadow: true })],
    },
    {
      name: 'Ground',
      parent: null,
      active: true,
      tags: ['Ground'],
      transform: { position: [0, -0.5, 0], rotation: [0, 0, 0], scale: [40, 1, 40] },
      components: [
        parseComponent({ type: 'MeshRenderer', primitive: 'box', color: '#6a9955' }),
        parseComponent({ type: 'Collider', shape: 'box' }),
      ],
    },
  ];
}

export const sceneCreate = defineCommand({
  name: 'scene_create',
  group: 'scene',
  kind: 'mutation',
  tier: 'extended',
  description:
    'Create a new scene file and (by default) open it. template \'basic\' adds a camera, a sun light and a ground plane. Example: {"name":"level2","template":"basic"}',
  input: z
    .object({
      name: z.string().regex(/^[\w-]+$/, 'Use letters, digits, _ and -'),
      template: z.enum(['empty', 'basic']).default('basic'),
      open: z.boolean().default(true),
    })
    .strict(),
  run(ctx, input) {
    const path = `scenes/${input.name}.scene.json`;
    if (ctx.state.scenes[path])
      throw new AigeError('CONFLICT', `Scene '${path}' already exists.`, { hint: 'Use scene_open.' });
    ctx.update((d) => {
      const scene = createSceneDoc(input.name);
      if (input.template === 'basic') {
        for (const e of basicSceneEntities()) scene.entities.push({ ...e, id: allocateEntityId(scene) });
      }
      d.scenes[path] = scene;
      if (input.open) d.activeScene = path;
    });
    return { path, opened: input.open };
  },
});

export const sceneOpen = defineCommand({
  name: 'scene_open',
  group: 'scene',
  kind: 'mutation',
  tier: 'extended',
  description: 'Make another scene the open (active) scene. Example: {"scene":"level2"}',
  input: z.object({ scene: z.string() }).strict(),
  run(ctx, input) {
    const path = resolveScenePath(ctx.state, input.scene);
    ctx.update((d) => {
      d.activeScene = path;
    });
    return { active: path };
  },
});

export const sceneSettings = defineCommand({
  name: 'scene_settings',
  group: 'scene',
  kind: 'mutation',
  tier: 'extended',
  description: `Update scene settings (sky/background color, ambient light, fog, environment lighting, kill height). Only the given fields change. Fields: ${signature(SceneSettings)}. Example: {"background":"#1a1a2e","fog":{"color":"#1a1a2e","near":20,"far":80}}`,
  input: patchOf(SceneSettings).extend({ scene: SceneRef }).strict(),
  run(ctx, { scene, ...patch }) {
    const provided = definedOnly(patch);
    ctx.update((d) => {
      Object.assign(sceneDraft(d, scene).settings, provided);
    });
    return { settings: getScene(ctx.state, scene).settings };
  },
});

export const sceneTree = defineCommand({
  name: 'scene_tree',
  group: 'scene',
  kind: 'query',
  tier: 'core',
  description:
    'Show the entity hierarchy of a scene as compact text: one line per entity with id, name, position, and components. Use this first to see what exists. Example: {"root":"Level","depth":2}',
  input: z
    .object({
      scene: SceneRef,
      root: EntityRef.optional().describe('Only show this subtree'),
      depth: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  run(ctx, input) {
    const scene = getScene(ctx.state, input.scene);
    const byParent = new Map<string | null, Entity[]>();
    for (const e of scene.entities) {
      const list = byParent.get(e.parent) ?? [];
      list.push(e);
      byParent.set(e.parent, list);
    }
    const lines: string[] = [];
    const visit = (e: Entity, depth: number) => {
      const t = e.transform;
      const bits = [`${'  '.repeat(depth)}${e.id} ${e.name}`];
      if (t.position.some((v) => v !== 0)) bits.push(`pos(${fmt(t.position)})`);
      if (t.rotation.some((v) => v !== 0)) bits.push(`rot(${fmt(t.rotation)})`);
      if (t.scale.some((v) => v !== 1)) bits.push(`scale(${fmt(t.scale)})`);
      if (e.components.length) bits.push(`[${e.components.map(componentSummary).join(', ')}]`);
      if (e.tags.length) bits.push(`#${e.tags.join(' #')}`);
      if (!e.active) bits.push('(inactive)');
      lines.push(bits.join(' '));
      const kids = byParent.get(e.id) ?? [];
      if (depth + 1 >= input.depth) {
        if (kids.length) lines.push(`${'  '.repeat(depth + 1)}... ${kids.length} children`);
        return;
      }
      for (const c of kids) visit(c, depth + 1);
    };
    const roots = input.root ? [resolveEntity(scene, input.root)] : (byParent.get(null) ?? []);
    for (const r of roots) visit(r, 0);
    const path = resolveScenePath(ctx.state, input.scene);
    return {
      scene: path,
      entityCount: scene.entities.length,
      tree: lines.join('\n') || '(empty scene)',
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

export const entityCreate = defineCommand({
  name: 'entity_create',
  group: 'scene',
  kind: 'mutation',
  tier: 'core',
  description: `Create an entity (game object) with optional parent, transform and components. Names are made unique among siblings. Returns the new id.
Example: {"name":"Coin","position":[0,1,0],"components":[{"type":"MeshRenderer","model":"models/coin.model.ts"},{"type":"Collider","shape":"sphere","radius":0.5,"isTrigger":true}],"tags":["Coin"]}
Components:
${componentReference()}`,
  input: z
    .object({
      name: z.string().min(1),
      parent: EntityRef.optional(),
      position: Vec3.optional(),
      rotation: EulerDeg.optional(),
      scale: Scale.optional(),
      components: z.array(ComponentInput).default([]),
      tags: z.array(z.string()).default([]),
      active: z.boolean().default(true),
      scene: SceneRef,
    })
    .strict(),
  run(ctx, input) {
    const scene = getScene(ctx.state, input.scene);
    const parent = input.parent ? resolveEntity(scene, input.parent) : null;
    const components = input.components.map((c) => parseComponent(c));
    const probe: Entity = {
      id: '',
      name: input.name,
      parent: null,
      active: true,
      tags: [],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [],
    };
    for (const c of components) {
      checkComponentAllowed(probe, c);
      probe.components.push(c);
    }
    let result = { id: '', name: '', path: '' };
    ctx.update((d) => {
      const s = sceneDraft(d, input.scene);
      const id = allocateEntityId(s);
      const name = uniqueSiblingName(s, parent?.id ?? null, input.name);
      s.entities.push({
        id,
        name,
        parent: parent?.id ?? null,
        active: input.active,
        tags: input.tags,
        transform: {
          position: input.position ?? [0, 0, 0],
          rotation: input.rotation ?? [0, 0, 0],
          scale: input.scale ?? [1, 1, 1],
        },
        components,
      });
      result = { id, name, path: '' };
    });
    const after = getScene(ctx.state, input.scene);
    result.path = entityPath(after, resolveEntity(after, result.id));
    return result;
  },
});

export const entityUpdate = defineCommand({
  name: 'entity_update',
  group: 'scene',
  kind: 'mutation',
  tier: 'core',
  description:
    'Change an entity: rename, move/rotate/scale, reparent (parent: null for root; world position is kept), activate/deactivate, or set tags. Only given fields change. Example: {"entity":"Player","position":[0,2,0],"rotation":[0,90,0]}',
  input: z
    .object({
      entity: EntityRef,
      name: z.string().min(1).optional(),
      position: Vec3.optional(),
      rotation: EulerDeg.optional(),
      scale: Scale.optional(),
      parent: EntityRef.nullable().optional().describe('New parent, or null to move to the scene root'),
      active: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      scene: SceneRef,
    })
    .strict(),
  run(ctx, input) {
    const scene = getScene(ctx.state, input.scene);
    const target = resolveEntity(scene, input.entity);
    let newParent: Entity | null | undefined;
    if (input.parent !== undefined) {
      newParent = input.parent === null ? null : resolveEntity(scene, input.parent);
      if (newParent && (newParent.id === target.id || isDescendant(scene, newParent.id, target.id))) {
        throw new AigeError(
          'INVALID_INPUT',
          `Cannot parent '${target.name}' to itself or one of its descendants.`,
        );
      }
    }
    // Keep world placement when reparenting (unless a new local transform is also given).
    const reparentTransform =
      newParent !== undefined ? localFromWorld(scene, worldMatrix(scene, target), newParent) : undefined;
    ctx.update((d) => {
      const s = sceneDraft(d, input.scene);
      const e = findDraftEntity(s, target.id);
      if (newParent !== undefined) {
        e.parent = newParent?.id ?? null;
        if (reparentTransform) e.transform = reparentTransform;
        e.name = uniqueSiblingName(s as SceneDoc, e.parent, e.name, e.id);
      }
      if (input.name !== undefined) e.name = uniqueSiblingName(s as SceneDoc, e.parent, input.name, e.id);
      if (input.position) e.transform.position = input.position;
      if (input.rotation) e.transform.rotation = input.rotation;
      if (input.scale) e.transform.scale = input.scale;
      if (input.active !== undefined) e.active = input.active;
      if (input.tags) e.tags = input.tags;
    });
    const after = getScene(ctx.state, input.scene);
    const e = resolveEntity(after, target.id);
    return { id: e.id, name: e.name, path: entityPath(after, e), transform: e.transform };
  },
});

export const entityDelete = defineCommand({
  name: 'entity_delete',
  group: 'scene',
  kind: 'mutation',
  tier: 'core',
  description: 'Delete one or more entities and all their children. Example: {"entity":["Coin (2)","e14"]}',
  input: z
    .object({
      entity: z.union([EntityRef, z.array(EntityRef).min(1)]),
      scene: SceneRef,
    })
    .strict(),
  run(ctx, input) {
    const scene = getScene(ctx.state, input.scene);
    const refs = Array.isArray(input.entity) ? input.entity : [input.entity];
    const ids = new Set<string>();
    for (const ref of refs) for (const e of subtree(scene, resolveEntity(scene, ref).id)) ids.add(e.id);
    ctx.update((d) => {
      const s = sceneDraft(d, input.scene);
      s.entities = s.entities.filter((e) => !ids.has(e.id));
    });
    return { deleted: [...ids] };
  },
});

export const entityDuplicate = defineCommand({
  name: 'entity_duplicate',
  group: 'scene',
  kind: 'mutation',
  tier: 'core',
  description:
    'Duplicate an entity (with children) `count` times. Each copy is shifted by `offset` from the previous one, which makes rows of coins or platforms easy. Example: {"entity":"Coin","count":5,"offset":[2,0,0]}',
  input: z
    .object({
      entity: EntityRef,
      count: z.number().int().min(1).max(500).default(1),
      offset: Vec3.default([0, 0, 0]),
      scene: SceneRef,
    })
    .strict(),
  run(ctx, input) {
    const scene = getScene(ctx.state, input.scene);
    const root = resolveEntity(scene, input.entity);
    const tree = subtree(scene, root.id);
    const created: { id: string; name: string }[] = [];
    ctx.update((d) => {
      const s = sceneDraft(d, input.scene);
      for (let i = 1; i <= input.count; i++) {
        const idMap = new Map<string, string>();
        for (const e of tree) idMap.set(e.id, allocateEntityId(s));
        for (const e of tree) {
          const copy: Entity = structuredClone(e) as Entity;
          copy.id = idMap.get(e.id)!;
          copy.parent = e.id === root.id ? e.parent : idMap.get(e.parent!)!;
          if (e.id === root.id) {
            copy.name = uniqueSiblingName(s as SceneDoc, copy.parent, e.name);
            copy.transform.position = [
              e.transform.position[0] + input.offset[0] * i,
              e.transform.position[1] + input.offset[1] * i,
              e.transform.position[2] + input.offset[2] * i,
            ];
            created.push({ id: copy.id, name: copy.name });
          }
          s.entities.push(copy);
        }
      }
    });
    return { created };
  },
});

export const entityFind = defineCommand({
  name: 'entity_find',
  group: 'scene',
  kind: 'query',
  tier: 'core',
  description:
    'Find entities by name (substring, case-insensitive), tag, or component type. Example: {"tag":"Coin"} or {"name":"platform","component":"Collider"}',
  input: z
    .object({
      name: z.string().optional(),
      tag: z.string().optional(),
      component: z.string().optional(),
      under: EntityRef.optional().describe('Only search this subtree'),
      limit: z.number().int().min(1).max(500).default(50),
      scene: SceneRef,
    })
    .strict(),
  run(ctx, input) {
    const scene = getScene(ctx.state, input.scene);
    const index = entityIndex(scene);
    let pool = scene.entities;
    if (input.under) pool = subtree(scene, resolveEntity(scene, input.under).id);
    if (input.component) getComponentDef(input.component);
    const q = input.name?.toLowerCase();
    const matches = pool.filter(
      (e) =>
        (!q || e.name.toLowerCase().includes(q)) &&
        (!input.tag || e.tags.includes(input.tag)) &&
        (!input.component || e.components.some((c) => c.type === input.component)),
    );
    return {
      total: matches.length,
      entities: matches.slice(0, input.limit).map((e) => ({
        id: e.id,
        path: entityPath(scene, e, index),
        position: worldTransform(scene, e, index).position.map((n) => Math.round(n * 1000) / 1000),
        components: e.components.map(componentSummary),
      })),
    };
  },
});

export const entityGet = defineCommand({
  name: 'entity_get',
  group: 'scene',
  kind: 'query',
  tier: 'core',
  description:
    'Get the full data of one entity: transform, world position, components with all properties, children. Example: {"entity":"Player"}',
  input: z.object({ entity: EntityRef, scene: SceneRef }).strict(),
  run(ctx, input) {
    const scene = getScene(ctx.state, input.scene);
    return describeEntity(scene, resolveEntity(scene, input.entity));
  },
});

// ---------------------------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------------------------

export const componentAdd = defineCommand({
  name: 'component_add',
  group: 'scene',
  kind: 'mutation',
  tier: 'core',
  description: `Add a component to an entity. Example: {"entity":"Crate","component":{"type":"RigidBody","kind":"dynamic","mass":2}}
Components:
${componentReference()}`,
  input: z.object({ entity: EntityRef, component: ComponentInput, scene: SceneRef }).strict(),
  run(ctx, input) {
    const scene = getScene(ctx.state, input.scene);
    const target = resolveEntity(scene, input.entity);
    const comp = parseComponent(input.component);
    checkComponentAllowed(target, comp);
    ctx.update((d) => {
      findDraftEntity(sceneDraft(d, input.scene), target.id).components.push(comp);
    });
    return { entity: target.id, component: comp };
  },
});

function findComponentIndex(entity: Entity, type: string, index?: number): number {
  getComponentDef(type);
  const matches = entity.components.flatMap((c, i) => (c.type === type ? [i] : []));
  if (matches.length === 0) {
    throw new AigeError('NOT_FOUND', `Entity '${entity.name}' has no ${type} component.`, {
      hint: `It has: ${entity.components.map((c) => c.type).join(', ') || 'no components'}. Use component_add.`,
    });
  }
  if (index !== undefined) {
    const i = matches[index];
    if (i === undefined)
      throw new AigeError(
        'NOT_FOUND',
        `Entity '${entity.name}' has only ${matches.length} ${type} component(s).`,
      );
    return i;
  }
  return matches[0]!;
}

export const componentUpdate = defineCommand({
  name: 'component_update',
  group: 'scene',
  kind: 'mutation',
  tier: 'core',
  description:
    'Change properties of a component on an entity; other properties keep their values. Set a property to null to clear it (or reset it to its default). `index` picks among multiple components of the same type (e.g. several Scripts). Example: {"entity":"Sun","type":"Light","props":{"intensity":3,"color":"#ffeedd"}}',
  input: z
    .object({
      entity: EntityRef,
      type: z.string(),
      props: z.record(z.string(), z.unknown()),
      index: z.number().int().min(0).optional(),
      scene: SceneRef,
    })
    .strict(),
  run(ctx, input) {
    const scene = getScene(ctx.state, input.scene);
    const target = resolveEntity(scene, input.entity);
    const i = findComponentIndex(target, input.type, input.index);
    const patch = parseComponentPatch(input.type, input.props);
    ctx.update((d) => {
      const comp = findDraftEntity(sceneDraft(d, input.scene), target.id).components[i]!;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete comp[k];
        else comp[k] = v;
      }
    });
    const after = resolveEntity(getScene(ctx.state, input.scene), target.id);
    return { entity: target.id, component: after.components[i] };
  },
});

export const componentRemove = defineCommand({
  name: 'component_remove',
  group: 'scene',
  kind: 'mutation',
  tier: 'extended',
  description: 'Remove a component from an entity. Example: {"entity":"Crate","type":"RigidBody"}',
  input: z
    .object({
      entity: EntityRef,
      type: z.string(),
      index: z.number().int().min(0).optional(),
      scene: SceneRef,
    })
    .strict(),
  run(ctx, input) {
    const scene = getScene(ctx.state, input.scene);
    const target = resolveEntity(scene, input.entity);
    const i = findComponentIndex(target, input.type, input.index);
    ctx.update((d) => {
      findDraftEntity(sceneDraft(d, input.scene), target.id).components.splice(i, 1);
    });
    return { entity: target.id, removed: input.type };
  },
});

export const sceneCommands = [
  sceneList,
  sceneCreate,
  sceneOpen,
  sceneSettings,
  sceneTree,
  entityCreate,
  entityUpdate,
  entityDelete,
  entityDuplicate,
  entityFind,
  entityGet,
  componentAdd,
  componentUpdate,
  componentRemove,
];
