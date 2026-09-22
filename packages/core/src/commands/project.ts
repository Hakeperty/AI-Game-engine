import { z } from 'zod';
import { AigeError } from '../errors.ts';
import { definedOnly, EulerDeg, patchOf, Vec3 } from '../schema/common.ts';
import {
  createMaterialDoc,
  type Entity,
  InputAxis,
  MaterialProps,
  type PrefabDoc,
  ProjectDoc,
} from '../schema/documents.ts';
import {
  allocateEntityId,
  entityPath,
  getScene,
  resolveEntity,
  resolveScenePath,
  subtree,
  uniqueSiblingName,
} from '../state.ts';
import { signature } from '../tools.ts';
import { defineCommand } from './define.ts';

const SceneRef = z.string().optional().describe('Scene path or name; defaults to the open scene');

function assetName(path: string): string {
  return path.split('/').pop()!.replace(/\..*$/, '');
}

function materialPath(nameOrPath: string): string {
  const p = nameOrPath.replaceAll('\\', '/');
  if (p.includes('/') || p.endsWith('.json')) return p.endsWith('.material.json') ? p : `${p}.material.json`;
  return `materials/${p}.material.json`;
}

function prefabPath(nameOrPath: string): string {
  const p = nameOrPath.replaceAll('\\', '/');
  if (p.includes('/') || p.endsWith('.json')) return p.endsWith('.prefab.json') ? p : `${p}.prefab.json`;
  return `prefabs/${p}.prefab.json`;
}

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

export const materialCreate = defineCommand({
  name: 'material_create',
  group: 'material',
  kind: 'mutation',
  tier: 'core',
  description: `Create a PBR material asset (materials/<name>.material.json) that MeshRenderers can reference via "material". Properties: ${signature(MaterialProps)}.
Example: {"name":"gold","color":"#ffc107","metalness":1,"roughness":0.25}`,
  input: MaterialProps.extend({
    name: z.string().min(1).describe("Material name or path, e.g. 'gold'"),
  }).strict(),
  run(ctx, { name, ...props }) {
    const path = materialPath(name);
    if (ctx.state.materials[path]) {
      throw new AigeError('CONFLICT', `Material '${path}' already exists.`, {
        hint: 'Use material_update to change it.',
      });
    }
    const doc = createMaterialDoc(props);
    ctx.update((d) => {
      d.materials[path] = doc;
    });
    return { path, material: doc };
  },
});

export const materialUpdate = defineCommand({
  name: 'material_update',
  group: 'material',
  kind: 'mutation',
  tier: 'core',
  description:
    'Change properties of an existing material; other properties keep their values. Example: {"material":"gold","roughness":0.4}',
  input: patchOf(MaterialProps)
    .extend({ material: z.string().min(1) })
    .strict(),
  run(ctx, { material, ...patch }) {
    const path = materialPath(material);
    if (!ctx.state.materials[path]) {
      throw new AigeError('NOT_FOUND', `Material '${path}' not found.`, {
        hint: `Materials: ${Object.keys(ctx.state.materials).join(', ') || 'none'}. Use material_create.`,
      });
    }
    ctx.update((d) => {
      Object.assign(d.materials[path]!, definedOnly(patch));
    });
    return { path, material: ctx.state.materials[path] };
  },
});

export const materialList = defineCommand({
  name: 'material_list',
  group: 'material',
  kind: 'query',
  tier: 'extended',
  description: 'List material assets with their main properties.',
  input: z.object({}).strict(),
  run(ctx) {
    return {
      materials: Object.entries(ctx.state.materials).map(([path, m]) => ({
        path,
        color: m.color,
        metalness: m.metalness,
        roughness: m.roughness,
        ...(m.map ? { map: m.map } : {}),
      })),
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Prefabs
// ---------------------------------------------------------------------------------------------

export const prefabCreate = defineCommand({
  name: 'prefab_create',
  group: 'prefab',
  kind: 'mutation',
  tier: 'extended',
  description:
    'Save an entity and its children as a reusable prefab (prefabs/<name>.prefab.json). The root position is reset to the origin. Example: {"entity":"Coin","name":"coin"}',
  input: z
    .object({
      entity: z.string().min(1),
      name: z.string().optional().describe('Prefab name or path; defaults to the entity name'),
      overwrite: z.boolean().default(false),
      scene: SceneRef,
    })
    .strict(),
  run(ctx, input) {
    const scene = getScene(ctx.state, input.scene);
    const root = resolveEntity(scene, input.entity);
    const path = prefabPath(input.name ?? root.name.toLowerCase().replace(/\s+/g, '-'));
    if (ctx.state.prefabs[path] && !input.overwrite) {
      throw new AigeError('CONFLICT', `Prefab '${path}' already exists.`, {
        hint: 'Pass overwrite: true to replace it.',
      });
    }
    const tree = subtree(scene, root.id);
    const idMap = new Map(tree.map((e, i) => [e.id, `p${i + 1}`]));
    const entities: Entity[] = tree.map((e) => {
      const copy = structuredClone(e) as Entity;
      copy.id = idMap.get(e.id)!;
      copy.parent = e.id === root.id ? null : idMap.get(e.parent!)!;
      if (e.id === root.id) copy.transform.position = [0, 0, 0];
      delete copy.prefab;
      return copy;
    });
    const doc: PrefabDoc = { format: 'aige.prefab', version: 1, name: assetName(path), entities };
    ctx.update((d) => {
      d.prefabs[path] = doc;
    });
    return { path, entities: entities.length };
  },
});

export const prefabInstantiate = defineCommand({
  name: 'prefab_instantiate',
  group: 'prefab',
  kind: 'mutation',
  tier: 'core',
  description:
    'Place a copy of a prefab in the scene. Optionally give several positions to place many copies at once. Example: {"prefab":"coin","positions":[[0,1,0],[2,1,0],[4,1,0]]}',
  input: z
    .object({
      prefab: z.string().min(1),
      position: Vec3.optional(),
      positions: z.array(Vec3).max(500).optional().describe('Place one copy per position'),
      rotation: EulerDeg.optional(),
      parent: z.string().optional(),
      name: z.string().optional(),
      scene: SceneRef,
    })
    .strict(),
  run(ctx, input) {
    const path = prefabPath(input.prefab);
    const prefab = ctx.state.prefabs[path];
    if (!prefab) {
      throw new AigeError('NOT_FOUND', `Prefab '${path}' not found.`, {
        hint: `Prefabs: ${Object.keys(ctx.state.prefabs).join(', ') || 'none'}. Create one with prefab_create.`,
      });
    }
    const scene = getScene(ctx.state, input.scene);
    const parent = input.parent ? resolveEntity(scene, input.parent) : null;
    const positions = input.positions ?? [input.position ?? [0, 0, 0]];
    const created: { id: string; name: string }[] = [];
    ctx.update((d) => {
      const s = d.scenes[resolveScenePath(d, input.scene)]!;
      for (const pos of positions) {
        const idMap = new Map(prefab.entities.map((e) => [e.id, allocateEntityId(s)]));
        for (const e of prefab.entities) {
          const copy = structuredClone(e) as Entity;
          copy.id = idMap.get(e.id)!;
          if (e.parent === null) {
            copy.parent = parent?.id ?? null;
            copy.name = uniqueSiblingName(s, copy.parent, input.name ?? e.name);
            copy.transform.position = pos;
            if (input.rotation) copy.transform.rotation = input.rotation;
            copy.prefab = path;
            created.push({ id: copy.id, name: copy.name });
          } else {
            copy.parent = idMap.get(e.parent)!;
          }
          s.entities.push(copy);
        }
      }
    });
    const after = getScene(ctx.state, input.scene);
    return {
      created: created.map((c) => ({ ...c, path: entityPath(after, resolveEntity(after, c.id)) })),
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Project settings
// ---------------------------------------------------------------------------------------------

export const projectSettings = defineCommand({
  name: 'project_settings',
  group: 'project',
  kind: 'mutation',
  tier: 'extended',
  description: `Change project settings: name, description, start scene, gravity, render options, window, and input bindings. Input actions/axes are merged by name (set an action to [] to clear it). Key codes follow KeyboardEvent.code ('KeyW', 'Space', 'ArrowLeft', 'ShiftLeft') plus 'MouseLeft', 'MouseRight', 'GamepadA/B/X/Y', 'GamepadLB/RB', 'GamepadStart'.
Example: {"gravity":[0,-25,0],"actions":{"dash":["KeyQ"]},"render":{"shadows":true}}`,
  input: z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
      startScene: z.string().optional(),
      gravity: Vec3.optional(),
      render: patchOf(ProjectDoc.shape.render).optional(),
      window: patchOf(ProjectDoc.shape.window).optional(),
      actions: z.record(z.string(), z.array(z.string())).optional(),
      axes: z.record(z.string(), InputAxis).optional(),
    })
    .strict(),
  run(ctx, input) {
    const startScene = input.startScene ? resolveScenePath(ctx.state, input.startScene) : undefined;
    ctx.update((d) => {
      const p = d.project;
      if (input.name !== undefined) p.name = input.name;
      if (input.description !== undefined) p.description = input.description;
      if (startScene) p.startScene = startScene;
      if (input.gravity) p.physics.gravity = input.gravity;
      if (input.render) Object.assign(p.render, definedOnly(input.render));
      if (input.window) Object.assign(p.window, definedOnly(input.window));
      for (const [k, v] of Object.entries(input.actions ?? {})) {
        if (v.length === 0) delete p.input.actions[k];
        else p.input.actions[k] = v;
      }
      for (const [k, v] of Object.entries(input.axes ?? {})) p.input.axes[k] = v;
    });
    return { project: ctx.state.project };
  },
});

export const projectCommands = [
  materialCreate,
  materialUpdate,
  materialList,
  prefabCreate,
  prefabInstantiate,
  projectSettings,
];
