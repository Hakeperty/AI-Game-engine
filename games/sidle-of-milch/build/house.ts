/**
 * Builds scenes/house.scene.json (Chapter 1: the cabin) through the AIGE tool API, the same calls an AI
 * makes over MCP. Re-run it after changing the layout:  node games/sidle-of-milch/build/house.ts
 *
 * Plan (meters; +X east, +Z south, y up). Footprint x∈[-5.2, 5.2], z∈[-4, 4].
 *   Ground floor (y 0 → 2.7): hall x∈[-1.2, 1.2] runs north–south to the front door (south wall).
 *     West: bedroom z∈[-4, 0] (moonlit window west), bathroom z∈[0, 4].
 *     East: kitchen z∈[-4, 1.6] (window over the sink, window east), storage z∈[1.6, 4].
 *     Stairwell x∈[0.2, 1.2], z∈[-4, 0] behind a plank wall with a locked door at its north end;
 *     the stairs rise southward to the upper floor.
 *   Upper floor (y 3 → 5.5): dark, dirty hallway; closed room west (locked);
 *     Murphy's room south-east x∈[1.2, 5.2], z∈[0.6, 4] with an east window (morning sun).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, createSceneDoc } from '@aige/core';
import { ProjectHost } from '@aige/host';

type V3 = [number, number, number];
type Comp = Record<string, unknown> & { type: string };
interface Spec {
  name: string;
  parent?: string;
  position?: V3;
  rotation?: V3;
  components?: Comp[];
  tags?: string[];
  active?: boolean;
}

const root = resolve(import.meta.dirname, '..');
// Start from an empty scene (the host would otherwise recreate the start scene itself).
writeFileSync(resolve(root, 'scenes/house.scene.json'), canonicalJson(createSceneDoc('house')));
const host = await ProjectHost.open(root, { render: null });

async function call<T = Record<string, unknown>>(tool: string, input: unknown): Promise<T> {
  const r = await host.call(tool, input, 'cli');
  if (!r.ok) throw new Error(`${tool} failed: ${JSON.stringify(r.error)}`);
  return r.result as T;
}

await call('scene_open', { scene: 'house' });
await call('project_settings', {
  startScene: 'scenes/house.scene.json',
  window: { title: 'The Sidle of Milch' },
});

// Placeholder photo materials until the photos are rendered from the character models.
for (const [name, color] of [
  ['photo1', '#b3a182'],
  ['photo2', '#aa9878'],
] as const) {
  const exists = readFileSafe(`materials/${name}.material.json`);
  if (!exists) await call('material_create', { name, color, roughness: 0.6 });
}

// ---------------------------------------------------------------------------------------------------------
// Entity helpers
// ---------------------------------------------------------------------------------------------------------
const groups: Record<string, string> = {};
async function group(name: string, parent?: string): Promise<string> {
  const r = await call<{ id: string }>('entity_create', {
    name,
    ...(parent ? { parent: groups[parent] } : {}),
  });
  groups[name] = r.id;
  return r.id;
}
const queue: Spec[] = [];
const add = (g: string, spec: Spec) => queue.push({ ...spec, parent: groups[g] ?? g });
async function flush(): Promise<void> {
  for (let i = 0; i < queue.length; i += 60) {
    const commands = queue.slice(i, i + 60).map((s) => ({ tool: 'entity_create', input: s }));
    await call('batch', { commands });
  }
  queue.length = 0;
}

const M = (name: string) => `models/${name}.model.ts`;
const MAT = (name: string) => `materials/${name}.material.json`;
const logs = { logs: MAT('log_wood'), frame: MAT('wood_table'), chink: MAT('plaster_chink') };

const EXT_R = 0.14; // exterior log radius
const INT_R = 0.11; // interior log radius
const G_H = 2.7; // ground floor wall height
const U_Y = 3.0; // upper floor level
const U_H = 2.5; // upper floor wall height

interface Opening {
  kind: 'window' | 'door';
  /** World coordinate of the opening's center along the wall. */
  at: number;
  width?: number;
  height?: number;
  sill?: number;
}

/** A log wall along X at z, from x0 to x1. */
function wallX(
  g: string,
  name: string,
  x0: number,
  x1: number,
  z: number,
  y: number,
  h: number,
  r: number,
  o?: Opening,
  overhang = 0,
) {
  const cx = (x0 + x1) / 2;
  wall(g, name, [cx, y, z], [0, 0, 0], x1 - x0, h, r, o ? { ...o, local: o.at - cx } : undefined, overhang);
}
/** A log wall along Z at x, from z0 to z1 (rotated 90°: model +X points to world -Z). */
function wallZ(
  g: string,
  name: string,
  z0: number,
  z1: number,
  x: number,
  y: number,
  h: number,
  r: number,
  o?: Opening,
  overhang = 0,
) {
  const cz = (z0 + z1) / 2;
  wall(g, name, [x, y, cz], [0, 90, 0], z1 - z0, h, r, o ? { ...o, local: cz - o.at } : undefined, overhang);
}
function wall(
  g: string,
  name: string,
  position: V3,
  rotation: V3,
  length: number,
  height: number,
  logRadius: number,
  o: (Opening & { local: number }) | undefined,
  overhang: number,
) {
  const params: Record<string, unknown> = { length, height, logRadius, overhang };
  if (o) {
    params.opening = o.kind;
    params.openingX = o.local;
    params.openingWidth = o.width ?? (o.kind === 'door' ? 0.95 : 1);
    params.openingHeight = o.height ?? (o.kind === 'door' ? 2.05 : 0.9);
    if (o.sill !== undefined) params.sill = o.sill;
  }
  add(g, {
    name,
    position,
    rotation,
    tags: ['Wall'],
    components: [
      { type: 'MeshRenderer', model: M('log-wall'), params, materials: logs },
      { type: 'Collider', shape: o ? 'mesh' : 'auto' },
    ],
  });
}

function slab(
  g: string,
  name: string,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  top: number,
  thickness: number,
  material: string,
  beams = false,
) {
  add(g, {
    name,
    position: [(x0 + x1) / 2, top, (z0 + z1) / 2],
    tags: ['Floor'],
    components: [
      {
        type: 'MeshRenderer',
        model: M('slab'),
        params: { width: x1 - x0, depth: z1 - z0, thickness, beams },
        materials: { slab: MAT(material), beams: MAT('log_wood') },
      },
      { type: 'Collider', shape: 'auto' },
    ],
  });
}

function furniture(
  g: string,
  name: string,
  kind: string,
  position: V3,
  rotY = 0,
  extra: Comp[] = [],
  params: Record<string, unknown> = {},
  active = true,
) {
  const woodMat = kind === 'round_table' || kind === 'chair' ? MAT('wood_table') : MAT('wood_cabinet');
  add(g, {
    name,
    position,
    rotation: [0, rotY, 0],
    active,
    tags: ['Furniture'],
    components: [
      {
        type: 'MeshRenderer',
        model: M('furniture'),
        params: { kind, ...params },
        materials: {
          ...(kind === 'fridge' || kind === 'toy_chest' ? {} : { body: woodMat }),
          frame: woodMat,
          chair: woodMat,
          top: woodMat,
          drawers: woodMat,
          doors: woodMat,
          cabinet: woodMat,
          shelf: woodMat,
          crate: MAT('wood_table'),
          blanket: MAT('wool_blanket'),
          mattress: MAT('fabric_cotton'),
          pillow: MAT('fabric_cotton'),
          ...(kind === 'toy_chest' ? { body: MAT('painted_blue'), lid: MAT('painted_blue') } : {}),
        },
      },
      { type: 'Collider', shape: 'auto' },
      ...extra,
    ],
  });
}

function prop(
  g: string,
  name: string,
  kind: string,
  position: V3,
  rotation: V3 = [0, 0, 0],
  extra: Comp[] = [],
  params: Record<string, unknown> = {},
  active = true,
  materials?: Record<string, string>,
) {
  add(g, {
    name,
    position,
    rotation,
    active,
    components: [
      {
        type: 'MeshRenderer',
        model: M('props'),
        params: { kind, ...params },
        ...(materials ? { materials } : {}),
      },
      ...extra,
    ],
  });
}

function irish(
  g: string,
  name: string,
  kind: string,
  position: V3,
  rotation: V3 = [0, 0, 0],
  extra: Comp[] = [],
  materials?: Record<string, string>,
  params: Record<string, unknown> = {},
) {
  add(g, {
    name,
    position,
    rotation,
    components: [
      {
        type: 'MeshRenderer',
        model: M('irish'),
        params: { kind, ...params },
        ...(materials ? { materials } : {}),
      },
      ...extra,
    ],
  });
}

const trigger = (name: string, g: string, position: V3, size: V3, t: Comp) =>
  add(g, {
    name,
    position,
    components: [
      { type: 'Collider', shape: 'box', size, isTrigger: true },
      { type: 'Trigger', ...t },
    ],
  });

// ---------------------------------------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------------------------------------
await group('Cabin');
for (const g of ['GroundFloor', 'UpperFloor', 'Furniture', 'Props', 'Doors']) await group(g, 'Cabin');
for (const g of ['Night', 'Morning', 'Audio', 'Story', 'Exterior']) await group(g);

// ---------------------------------------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------------------------------------
// Exterior, ground floor
wallX(
  'GroundFloor',
  'Wall_N',
  -5.2,
  5.2,
  -4,
  0,
  G_H,
  EXT_R,
  { kind: 'window', at: 3.15, width: 1.0, sill: 1.1, height: 0.85 },
  0.3,
);
wallX(
  'GroundFloor',
  'Wall_S',
  -5.2,
  5.2,
  4,
  0,
  G_H,
  EXT_R,
  { kind: 'door', at: 0, width: 1.0, height: 2.1 },
  0.3,
);
wallZ(
  'GroundFloor',
  'Wall_W',
  -4,
  4,
  -5.2,
  0,
  G_H,
  EXT_R,
  { kind: 'window', at: -2.0, width: 0.9, sill: 1.0, height: 1.0 },
  0.3,
);
wallZ(
  'GroundFloor',
  'Wall_E',
  -4,
  4,
  5.2,
  0,
  G_H,
  EXT_R,
  { kind: 'window', at: -1.6, width: 0.9, sill: 1.0, height: 1.0 },
  0.3,
);
// Interior, ground floor (butting against the exterior walls' inner faces)
const IN0 = -4 + EXT_R;
const IN1 = 4 - EXT_R;
wallZ('GroundFloor', 'Wall_Bedroom_Hall', IN0, 0, -1.2, 0, G_H, INT_R, {
  kind: 'door',
  at: -0.85,
  width: 0.95,
});
wallZ('GroundFloor', 'Wall_Bath_Hall', 0, IN1, -1.2, 0, G_H, INT_R, { kind: 'door', at: 2.2, width: 0.95 });
wallX('GroundFloor', 'Wall_Bedroom_Bath', -5.2 + EXT_R, -1.2 - INT_R, 0, 0, G_H, INT_R);
wallZ('GroundFloor', 'Wall_Stairwell_Kitchen', IN0, 0, 1.2, 0, G_H, INT_R);
wallZ('GroundFloor', 'Wall_Hall_KitchenDoor', 0, 1.6, 1.2, 0, G_H, INT_R, {
  kind: 'door',
  at: 0.62,
  width: 1.0,
});
wallZ('GroundFloor', 'Wall_Hall_Storage', 1.6, IN1, 1.2, 0, G_H, INT_R, {
  kind: 'door',
  at: 2.7,
  width: 0.95,
});
wallX('GroundFloor', 'Wall_Kitchen_Storage', 1.2 + INT_R, 5.2 - EXT_R, 1.6, 0, G_H, INT_R);
wallZ('GroundFloor', 'Wall_Stairwell', IN0, 0, 0.2, 0, G_H, 0.09, {
  kind: 'door',
  at: -3.35,
  width: 0.9,
  height: 2.0,
});
wallX('GroundFloor', 'Wall_Stairwell_S', 0.2, 1.2 - INT_R, 0, 0, G_H, 0.09);

// Exterior, upper floor
wallX('UpperFloor', 'Wall_N_Up', -5.2, 5.2, -4, U_Y, U_H, EXT_R, undefined, 0.3);
wallX(
  'UpperFloor',
  'Wall_S_Up',
  -5.2,
  5.2,
  4,
  U_Y,
  U_H,
  EXT_R,
  { kind: 'window', at: -0.1, width: 0.8, sill: 0.9, height: 1.0 },
  0.3,
);
wallZ(
  'UpperFloor',
  'Wall_W_Up',
  -4,
  4,
  -5.2,
  U_Y,
  U_H,
  EXT_R,
  { kind: 'window', at: -1.0, width: 0.8, sill: 0.9, height: 0.9 },
  0.3,
);
wallZ(
  'UpperFloor',
  'Wall_E_Up',
  -4,
  4,
  5.2,
  U_Y,
  U_H,
  EXT_R,
  { kind: 'window', at: 2.3, width: 1.0, sill: 0.8, height: 1.1 },
  0.3,
);
// Interior, upper floor
wallZ('UpperFloor', 'Wall_Closed_Hall', IN0, IN1, -1.2, U_Y, U_H, INT_R, {
  kind: 'door',
  at: -1.5,
  width: 0.95,
});
wallZ('UpperFloor', 'Wall_Murphy_Hall', 0.6, IN1, 1.2, U_Y, U_H, INT_R, {
  kind: 'door',
  at: 2.8,
  width: 0.95,
});
wallX('UpperFloor', 'Wall_Murphy_N', 1.2 + INT_R, 5.2 - EXT_R, 0.6, U_Y, U_H, INT_R);
wallZ('UpperFloor', 'Wall_Attic_Hall', IN0, 0.6, 1.2, U_Y, U_H, INT_R);
wallZ('UpperFloor', 'Railing_Stairwell', IN0, -0.2, 0.2, U_Y, 1.0, 0.07);

// ---------------------------------------------------------------------------------------------------------
// Floors and ceilings
// ---------------------------------------------------------------------------------------------------------
slab('GroundFloor', 'Floor_Ground', -5.2, 5.2, -4, 4, 0, 0.2, 'floor_old_wood');
slab('UpperFloor', 'Floor_Upper_W', -5.2, 0.2, -4, 4, U_Y, 0.3, 'floor_dirty_planks', true);
slab('UpperFloor', 'Floor_Upper_SE', 0.2, 5.2, 0, 4, U_Y, 0.3, 'floor_dirty_planks', true);
slab('UpperFloor', 'Floor_Upper_NE', 1.2, 5.2, -4, 0, U_Y, 0.3, 'floor_dirty_planks', true);
slab('UpperFloor', 'Ceiling_Upper', -5.2, 5.2, -4, 4, 5.62, 0.12, 'floor_old_wood', true);

// Stairs: bottom step at the north end of the stairwell, rising south to the upper floor.
add('GroundFloor', {
  name: 'Stairs',
  position: [0.7, 0, -3.85],
  components: [
    {
      type: 'MeshRenderer',
      model: M('stairs'),
      params: { width: 0.92, rise: U_Y, run: 3.75, steps: 15, rail: false },
      materials: { treads: MAT('floor_old_wood'), stringers: MAT('log_wood') },
    },
  ],
});
// Walkable ramp along the stairs (the player's capsule glides up it).
add('GroundFloor', {
  name: 'Stairs_Ramp',
  position: [0.7, U_Y / 2 - 0.05, -3.85 + 3.75 / 2],
  rotation: [-((Math.atan2(U_Y, 3.75) * 180) / Math.PI), 0, 0],
  components: [{ type: 'Collider', shape: 'box', size: [0.92, 0.1, Math.hypot(U_Y, 3.75) + 0.1] }],
});

// ---------------------------------------------------------------------------------------------------------
// Doors (origin at the hinge; the model extends along +X)
// ---------------------------------------------------------------------------------------------------------
const door = (name: string, position: V3, rotY: number, c: Comp, params: Record<string, unknown> = {}) =>
  add('Doors', {
    name,
    position,
    rotation: [0, rotY, 0],
    tags: ['Door'],
    components: [
      {
        type: 'MeshRenderer',
        model: M('door'),
        params,
        materials: { door: MAT('wood_cabinet'), braces: MAT('wood_table') },
      },
      { type: 'Collider', shape: 'auto' },
      { type: 'Door', ...c },
    ],
  });
door('Door_Bedroom', [-1.2, 0, -1.325], -90, { openAngle: -95, startOpen: false, prompt: 'Open' });
door('Door_Bathroom', [-1.2, 0, 1.725], -90, { openAngle: -95, prompt: 'Open' });
door('Door_Storage', [1.2, 0, 2.225], -90, { openAngle: 95, prompt: 'Open' });
door(
  'Door_Stairs',
  [0.2, 0, -3.8],
  -90,
  {
    openAngle: -95,
    locked: true,
    unlockFlag: 'stairs_unlocked',
    lockedText: "It's locked. Maybe I should look around down here first.",
    prompt: 'Open',
  },
  { width: 0.88, height: 1.98 },
);
door(
  'Door_Front',
  [-0.5, 0, 4],
  0,
  {
    openAngle: 95,
    locked: true,
    unlockFlag: 'leave_cabin',
    lockedText: 'Not yet. I have to find Murphy.',
    prompt: 'Open',
  },
  { width: 0.98, height: 2.08, planks: 6 },
);
door('Door_ClosedRoom', [-1.2, U_Y, -1.975], -90, {
  locked: true,
  lockedText: "It won't open.",
  prompt: 'Open',
});
door('Door_Murphy', [1.2, U_Y, 2.325], -90, { openAngle: 100, startOpen: true, prompt: 'Close' });

// ---------------------------------------------------------------------------------------------------------
// Furniture
// ---------------------------------------------------------------------------------------------------------
// Bedroom
furniture('Furniture', 'Bed', 'bed', [-4.33, 0, -2.8], 180);
furniture('Furniture', 'Nightstand', 'nightstand', [-3.47, 0, -3.6], 0);
furniture('Furniture', 'Dresser', 'dresser', [-1.58, 0, -2.6], -90);
furniture('Furniture', 'Wardrobe', 'wardrobe', [-4.35, 0, -0.42], 180);
// Kitchen
furniture('Furniture', 'Counter_Drawers', 'counter', [1.95, 0, -3.56], 0);
furniture('Furniture', 'Counter_Drawers_Open', 'counter', [1.95, 0, -3.56], 0, [], { open: 1 }, false);
furniture('Furniture', 'Counter_Sink', 'sink_counter', [3.15, 0, -3.56], 0);
furniture('Furniture', 'Fridge', 'fridge', [4.73, 0, -3.3], -90);
furniture('Furniture', 'Kitchen_Cabinet', 'wall_cabinet', [1.95, 1.5, -3.79], 0);
furniture('Furniture', 'Table', 'round_table', [3.2, 0, -0.9], 0);
[90, 210, 330].forEach((deg, i) => {
  const a = (deg * Math.PI) / 180;
  const x = 3.2 + Math.cos(a) * 0.78;
  const z = -0.9 + Math.sin(a) * 0.78;
  // chairs face the table: model front (+Z) points toward the center
  const rotY = (Math.atan2(3.2 - x, -0.9 - z) * 180) / Math.PI + 180;
  irish(
    'Furniture',
    `Chair_${i + 1}`,
    'sugan_chair',
    [x, 0, z],
    [0, rotY + (i === 2 ? 12 : 0), 0],
    [{ type: 'Collider', shape: 'auto' }],
    { chair: MAT('wood_table') },
  );
});
// Bathroom
furniture('Furniture', 'Bathtub', 'bathtub', [-4.55, 0, 2.75], 0);
furniture('Furniture', 'Basin', 'basin', [-3.0, 0, 0.47], 0);
furniture('Furniture', 'Mirror_Cabinet', 'wall_cabinet', [-3.0, 1.22, 0.2], 0, [
  {
    type: 'Interactable',
    prompt: 'Open the cabinet',
    cutscene: 'cutscenes/cabinet.cutscene.json',
    setFlag: 'saw_toothbrushes',
    once: true,
    range: 1.4,
  },
]);
furniture('Furniture', 'Mirror_Cabinet_Open', 'wall_cabinet', [-3.0, 1.22, 0.2], 0, [], { open: 1 }, false);
furniture('Furniture', 'Toilet', 'toilet', [-1.95, 0, 3.5], 180);
// Storage
furniture('Furniture', 'Coat_Rack', 'coat_rack', [3.6, 0, 1.73], 0);
furniture('Furniture', 'Storage_Shelf', 'shelf', [4.9, 0, 3.1], -90);
furniture('Furniture', 'Crate_1', 'crate', [2.0, 0, 3.5], 17);
furniture('Furniture', 'Crate_2', 'crate', [2.55, 0, 3.55], -8);
furniture('Furniture', 'Crate_3', 'crate', [2.25, 0.5, 3.5], 33);
// Upstairs: Murphy's room
furniture('Furniture', 'Murphy_Bed', 'small_bed', [4.45, U_Y, 1.55], -90, [], { fabric: '#5b6f8a' });
furniture('Furniture', 'Toy_Chest', 'toy_chest', [2.2, U_Y, 3.55], 180);
furniture('Furniture', 'Murphy_Shelf', 'shelf', [1.55, U_Y, 1.5], 90);
// Upstairs: junk in the dirty hallway and closed room
furniture('Furniture', 'Junk_Crate_1', 'crate', [-0.8, U_Y, -3.5], 25);
furniture('Furniture', 'Junk_Crate_2', 'crate', [-0.75, U_Y + 0.5, -3.45], -15);
furniture('Furniture', 'Closed_Room_Wardrobe', 'wardrobe', [-4.6, U_Y, 1.0], 90);
furniture('Furniture', 'Closed_Room_Bed', 'bed', [-3.4, U_Y, -3.0], 0, [], { fabric: '#7a6a5a', wear: 0.9 });
furniture('Furniture', 'Hall_Chair', 'chair', [-0.7, 0, 3.2], 160, [], { wear: 0.9 });

await flush();

// ---------------------------------------------------------------------------------------------------------
// Props and story objects
// ---------------------------------------------------------------------------------------------------------
prop(
  'Story',
  'Photo_1',
  'frame_stand',
  [-1.62, 0.98, -2.42],
  [0, -90, 0],
  [
    {
      type: 'Interactable',
      prompt: 'Look at the photo',
      cutscene: 'cutscenes/photo_1.cutscene.json',
      setFlag: 'saw_photo_1',
      range: 1.5,
    },
  ],
  {},
  true,
  { photo: MAT('photo1') },
);
prop(
  'Story',
  'Photo_2',
  'frame_magnet',
  [4.385, 1.3, -3.18],
  [0, -90, 3],
  [
    {
      type: 'Interactable',
      prompt: 'Look at the photo',
      voice: 'milch_photo_2',
      setFlag: 'saw_photo_2',
      range: 1.5,
    },
  ],
  {},
  true,
  { photo: MAT('photo2') },
);
prop('Story', 'Knife_In_Drawer', 'knife', [1.66, 0.66, -2.98], [0, 12, 0], [], {}, false);
prop('Story', 'Knife_Stuck', 'knife_stuck', [3.05, U_Y, 2.15], [0, 35, 4], [], {}, false);
prop('Story', 'Toothbrushes', 'toothbrush_cup', [-3.02, 1.22 + 0.285, 0.2]);
prop(
  'Story',
  'Shield',
  'shield',
  [5.05, U_Y + 1.55, 1.3],
  [0, -90, 0],
  [
    {
      type: 'Interactable',
      prompt: 'Look at the shield',
      text: 'A shield with a whirl... it was always here.',
      range: 1.8,
    },
  ],
);
prop('Props', 'Bulb_Kitchen', 'bulb', [3.2, 2.62, -0.9], [0, 0, 0], [], { glow: 3 });
prop('Props', 'Bulb_Hall', 'bulb', [0, 2.62, 2.0], [0, 0, 0], [], { glow: 1.5 });
prop('Props', 'Rug_Hall', 'rug', [0, 0.001, 2.6], [0, 90, 0], [], { size: 1.1 }, true, {
  rug: MAT('carpet_dirty'),
});
prop('Props', 'Rug_Murphy', 'rug', [3.3, U_Y + 0.001, 2.3], [0, 10, 0], [], { size: 0.9, color: '#3d4f6b' });
prop('Props', 'Ball', 'ball', [2.7, U_Y, 3.1]);
prop('Props', 'Blocks', 'blocks', [3.8, U_Y, 3.0], [0, 20, 0]);
prop('Props', 'Rocking_Horse', 'horse', [4.6, U_Y, 3.4], [0, -130, 0]);
for (const [i, p] of (
  [
    [-0.7, U_Y, -1.2, 1.3],
    [-0.4, U_Y, -2.5, 0.9],
    [-0.9, U_Y, 1.8, 1.1],
    [0.6, U_Y, 3.3, 0.8],
    [-3.2, U_Y, 2.0, 1.4],
  ] as [number, number, number, number][]
).entries())
  prop('Props', `Dirt_${i + 1}`, 'dirt', [p[0], p[1], p[2]], [0, i * 67, 0], [], { size: p[3] });
for (const [i, [pos, rot]] of (
  [
    [
      [-5.06, 2.2, -3.86],
      [0, 0, 0],
    ],
    [
      [5.06, 2.25, -3.86],
      [0, -90, 0],
    ],
    [
      [-1.34, 2.2, 3.86],
      [0, 90, 0],
    ],
    [
      [-1.06, U_Y + 2.05, -3.86],
      [0, 0, 0],
    ],
    [
      [5.06, U_Y + 2.05, 3.86],
      [0, 180, 0],
    ],
    [
      [1.34, U_Y + 2.1, 0.74],
      [0, 0, 0],
    ],
  ] as [V3, V3][]
).entries())
  prop('Props', `Cobweb_${i + 1}`, 'cobweb', pos, rot, [], { size: 1 + (i % 3) * 0.3 });

// ---------------------------------------------------------------------------------------------------------
// An old Irish home, and what it says (environmental storytelling; see STORY.md "Lore")
// ---------------------------------------------------------------------------------------------------------
const see = (text: string, prompt = 'Look', range = 1.5): Comp => ({
  type: 'Interactable',
  prompt,
  text,
  range,
});
// Kitchen
irish(
  'Furniture',
  'Dresser',
  'dresser',
  [4.83, 0, 0.55],
  [0, -90, 0],
  [{ type: 'Collider', shape: 'auto' }],
  {
    dresser: MAT('painted_blue'),
    doors: MAT('painted_blue'),
  },
);
irish('Furniture', 'Range', 'range', [2.6, 0, 1.18], [0, 180, 0], [{ type: 'Collider', shape: 'auto' }]);
irish('Props', 'Kettle', 'kettle', [2.8, 0.93, 1.2], [0, 160, 0]);
irish(
  'Props',
  'Turf_Basket',
  'turf_basket',
  [3.45, 0, 1.12],
  [0, 20, 0],
  [{ type: 'Collider', shape: 'auto' }],
);
irish(
  'Story',
  'Sacred_Heart',
  'sacred_heart',
  [1.32, 1.72, -2.2],
  [0, 90, 0],
  [see('The Sacred Heart. The lamp under it is still lit... who keeps it burning?')],
  { picture: MAT('story_sacred_heart') },
);
irish('Story', 'Red_Lamp', 'red_lamp', [1.32, 1.36, -2.2], [0, 90, 0], [], undefined, { glow: 1.1 });
add('Night', {
  name: 'Red_Lamp_Glow',
  position: [1.5, 1.3, -2.2],
  components: [
    {
      type: 'Light',
      kind: 'point',
      color: '#ff2414',
      intensity: 0.12,
      range: 1.8,
      castShadow: false,
      flicker: 0.15,
    },
  ],
});
prop(
  'Story',
  'Calendar',
  'calendar',
  [1.32, 1.6, -3.3],
  [0, 90, 0],
  [see('Every day crossed off... up to the thirteenth. The fourteenth is circled. After that, nothing.')],
  {},
  true,
  { photo: MAT('story_calendar') },
);
prop(
  'Story',
  'Hawthorn_Jar',
  'jar_sprig',
  [3.05, 0.765, -0.75],
  [0, 30, 0],
  [see('Hawthorn. Nobody brings hawthorn into a house... Mam always said that.', 'Look', 1.3)],
);
prop('Props', 'Mug_1', 'mug', [3.42, 0.765, -1.08], [0, 110, 0]);
prop('Props', 'Mug_2', 'mug', [2.92, 0.765, -1.15], [0, -40, 0]);
prop('Props', 'Newspaper', 'newspaper', [3.4, 0.768, -0.62], [0, 24, 0]);
prop('Props', 'Plates_Counter', 'plates', [1.62, 0.9, -3.55]);
prop('Props', 'Bottle_1', 'bottle', [2.35, 0.9, -3.72]);
prop('Props', 'Bottle_2', 'bottle', [2.47, 0.9, -3.62], [0, 60, 0]);
prop('Props', 'Bottle_Floor', 'bottle', [4.2, 0.04, -2.2], [0, 0, 88]);
// Hall and front door
irish('Story', 'Brigid_Cross', 'brigid_cross', [0, 2.33, 3.85], [0, 180, 0]);
irish('Props', 'Holy_Water_Font', 'holy_water_font', [0.78, 1.35, 3.85], [0, 180, 0]);
prop('Story', 'Horseshoe', 'horseshoe', [0, 2.28, 4.16]);
prop(
  'Story',
  'Saucer_Of_Milk',
  'saucer_milk',
  [0.55, 0, 3.55],
  [0, 0, 0],
  [see("A saucer of milk... it's fresh. Who left this here?", 'Look', 1.4)],
);
// Bedroom
irish('Props', 'Rosary', 'rosary', [-3.38, 0.585, -3.55], [0, 30, 0]);
prop('Props', 'Candle_Bedroom', 'candle', [-3.58, 0.585, -3.62]);
// Murphy's room: his drawing on the wall
prop(
  'Story',
  'Murphy_Drawing',
  'paper',
  [2.7, U_Y + 1.35, 0.72],
  [0, 0, 0],
  [
    see(
      'Murphy drew this. Me, him... and someone between us. Why did he scribble out the face?',
      'Look',
      1.6,
    ),
  ],
  { size: 1.2 },
  true,
  { photo: MAT('story_drawing') },
);
// Upstairs: a trail of dirt from the top of the stairs to the locked room
for (const [i, [x, z, sz]] of (
  [
    [-0.15, -0.25, 0.45],
    [-0.5, -0.8, 0.5],
    [-0.85, -1.3, 0.55],
    [-1.05, -1.7, 0.4],
  ] as [number, number, number][]
).entries())
  prop('Props', `Dirt_Trail_${i + 1}`, 'dirt', [x, U_Y, z], [0, i * 41, 0], [], { size: sz });

// Decay: water stains, mold, drips, spills and drag marks (Decal components project along local -Y)
const DECAL = (name: string) => `textures/decals/${name}.png`;
const decal = (name: string, pos: V3, rot: V3, texture: string, size: V3, _opacity = 1) =>
  add('Props', {
    name,
    position: pos,
    rotation: rot,
    components: [{ type: 'Decal', texture: DECAL(texture), size, opacity: 1 }],
  });
const UP: V3 = [180, 0, 0]; // project up onto a ceiling
const WALL_W: V3 = [0, 0, -90]; // project toward -X (a wall facing +X)
const WALL_E: V3 = [0, 0, 90]; // project toward +X
decal('Stain_Ceiling_Kitchen', [3.5, 2.6, -2.2], UP, 'water_stain', [1.7, 0.5, 1.7], 0.55);
decal('Stain_Ceiling_Bedroom', [-3.6, 2.6, -1.2], UP, 'water_stain', [1.3, 0.5, 1.3], 0.5);
decal('Stain_Ceiling_Hall', [0.1, 2.6, 2.6], UP, 'water_stain', [1.2, 0.5, 1.2], 0.45);
decal('Stain_Ceiling_Upstairs', [-0.4, U_Y + 2.4, -0.6], UP, 'water_stain', [1.6, 0.5, 1.6], 0.6);
decal('Mold_Bathroom_1', [-4.98, 0.55, 3.55], WALL_W, 'mold', [0.9, 0.35, 1.1], 0.9);
decal('Mold_Bathroom_2', [-4.98, 2.2, 0.4], WALL_W, 'mold', [0.8, 0.35, 0.8], 0.8);
decal('Mold_Bathroom_3', [-1.33, 0.45, 3.2], WALL_E, 'mold', [0.9, 0.35, 0.9], 0.75);
decal('Mold_Upstairs', [-1.2 + 0.13, U_Y + 0.5, -3.3], WALL_E, 'mold', [1.2, 0.35, 1.0], 0.8);
decal('Drips_Bedroom_Window', [-4.98, 0.5, -2.0], WALL_W, 'drips', [0.9, 0.35, 1.0], 0.75);
decal('Drips_Kitchen_Window', [5.06, 0.5, -1.6], WALL_E, 'drips', [0.9, 0.35, 1.0], 0.7);
decal('Stain_Floor_Kitchen', [4.15, 0.05, -2.1], [0, 30, 0], 'floor_stain', [1.1, 0.3, 1.1], 0.8);
decal('Stain_Floor_Hall', [-0.35, 0.05, 1.1], [0, 75, 0], 'floor_stain', [0.9, 0.3, 0.9], 0.7);
decal('Stain_Floor_Bedroom', [-2.9, 0.05, -1.5], [0, 140, 0], 'floor_stain', [0.8, 0.3, 0.8], 0.6);
decal('Drag_Marks_Upstairs', [-0.6, U_Y + 0.05, -0.98], [0, 121.8, 0], 'drag', [1.9, 0.3, 0.55], 0.85);

// ---------------------------------------------------------------------------------------------------------
// Characters and camera
// ---------------------------------------------------------------------------------------------------------
add('Story', {
  name: 'Milch',
  position: [-3.3, 0, -2.3],
  rotation: [0, 90, 0],
  tags: ['Player'],
  components: [
    { type: 'CharacterController', height: 1.78, radius: 0.28 },
    { type: 'Script', script: 'builtin:PlayerController', props: { walkSpeed: 1.5, runSpeed: 4.2 } },
    {
      type: 'MeshRenderer',
      model: M('milch'),
      // scanned fabrics on the garments (vertex colours add tint, wear and occlusion); skin_* parts get SSS
      materials: {
        hoodie: MAT('cloth_hoodie'),
        jeans: MAT('cloth_denim'),
        boots: MAT('cloth_leather'),
        belt: MAT('cloth_leather'),
      },
    },
    { type: 'Animator', initial: 'idle', locomotion: true },
  ],
});
add('Story', {
  name: 'Camera',
  position: [-3.3, 1.7, -0.6],
  components: [
    {
      type: 'Script',
      script: 'builtin:ThirdPersonCamera',
      props: { target: 'Milch', distance: 1.8, shoulder: 0.55, height: 1.55, fov: 55 },
    },
  ],
});

// ---------------------------------------------------------------------------------------------------------
// Story triggers
// ---------------------------------------------------------------------------------------------------------
trigger('Trigger_Hall', 'Story', [-0.5, 1, -0.85], [1.3, 2, 1.0], {
  cutscene: 'cutscenes/cs2_hall.cutscene.json',
  setFlag: 'entered_hall',
});
trigger('Trigger_Kitchen', 'Story', [1.95, 1, 0.62], [0.9, 2, 1.1], {
  cutscene: 'cutscenes/cs3_kitchen.cutscene.json',
  requireFlag: 'entered_hall',
  setFlag: 'searched_kitchen',
});
trigger('Trigger_Table', 'Story', [3.2, 1, -0.9], [2.6, 2, 2.6], {
  voice: 'milch_table',
  requireFlag: 'has_knife',
  setFlag: 'saw_table',
});
trigger('Trigger_Bathroom', 'Story', [-2.2, 1, 2.2], [1.6, 2, 1.6], { setFlag: 'found_bathroom' });
trigger('Trigger_Storage', 'Story', [3.1, 1, 2.8], [3.2, 2, 2.0], { setFlag: 'found_storage' });
trigger('Trigger_Upstairs', 'Story', [0.0, U_Y + 1, 1.0], [2.2, 2, 1.2], {
  voice: 'milch_upstairs',
  requireFlag: 'stairs_unlocked',
});
trigger('Trigger_Murphys_Room', 'Story', [3.3, U_Y + 1, 2.4], [2.6, 2, 2.4], {
  cutscene: 'cutscenes/cs4_empty.cutscene.json',
  requireFlag: 'stairs_unlocked',
  setFlag: 'fainted',
});
trigger('Trigger_Leave', 'Story', [0, 1, 4.35], [1.2, 2, 0.5], {
  cutscene: 'cutscenes/cs6_leave.cutscene.json',
  requireFlag: 'leave_cabin',
});
add('Story', {
  name: 'Chapter1',
  components: [{ type: 'Script', script: 'scripts/Chapter1.cs' }],
});

// ---------------------------------------------------------------------------------------------------------
// Lighting, environments, ambience
// ---------------------------------------------------------------------------------------------------------
add('Night', {
  name: 'Environment_Night',
  components: [
    {
      type: 'Environment',
      hdri: 'textures/hdri/moonlit_golf_2k.hdr',
      hdriRotation: 140,
      skyEnergy: 0.35,
      ambient: 0.7,
      exposure: 1.2,
      toneMapping: 'agx',
      fogColor: '#16201f',
      fogDensity: 0.008,
      volumetricFog: 0.03,
      ssao: 1.2,
      bloom: 0.45,
      contrast: 1.22,
      saturation: 0.6,
      temperature: -0.18,
      tint: -0.14,
      vignette: 0.48,
      grain: 0.3,
      chromaticAberration: 0.35,
    },
  ],
});
add('Night', {
  name: 'Moon',
  rotation: [-50.4, -44.4, 0],
  components: [{ type: 'Light', kind: 'directional', color: '#9fb4dc', intensity: 1.5, castShadow: true }],
});
add('Night', {
  name: 'Lightning',
  rotation: [-50.4, 44.4, 0],
  components: [{ type: 'Light', kind: 'directional', color: '#cdd9ff', intensity: 0, castShadow: true }],
});
add('Night', {
  name: 'Light_Kitchen',
  position: [3.2, 2.0, -0.9],
  components: [
    {
      type: 'Light',
      kind: 'point',
      color: '#ffb46b',
      intensity: 0.9,
      range: 6,
      castShadow: true,
      flicker: 0.25,
    },
  ],
});
add('Night', {
  name: 'Light_Hall',
  position: [0, 2.0, 2.0],
  components: [
    {
      type: 'Light',
      kind: 'point',
      color: '#ffac60',
      intensity: 0.55,
      range: 5,
      castShadow: true,
      flicker: 0.55,
    },
  ],
});
// Faint, shadowless "moon bounce" fills so dark rooms stay readable (as in most realistic games).
for (const [name, pos, energy, range] of [
  ['Fill_Bedroom', [-3.2, 2.2, -2.0], 0.35, 5],
  ['Fill_Bathroom', [-3.2, 2.2, 2.0], 0.25, 5],
  ['Fill_Hall', [-0.4, 2.2, -2.0], 0.2, 4],
  ['Fill_Storage', [3.2, 2.2, 2.8], 0.2, 4],
  ['Fill_Upstairs_Hall', [-0.4, 5.1, 0.5], 0.3, 7],
  ['Fill_Murphy', [3.2, 5.1, 2.3], 0.3, 5],
] as [string, V3, number, number][])
  add('Night', {
    name,
    position: pos,
    components: [
      { type: 'Light', kind: 'point', color: '#7688ad', intensity: energy, range, castShadow: false },
    ],
  });
add('Morning', {
  name: 'Environment_Morning',
  active: false,
  components: [
    {
      type: 'Environment',
      hdri: 'textures/hdri/autumn_forest_01_2k.hdr',
      skyEnergy: 1.0,
      ambient: 0.8,
      exposure: 1.0,
      toneMapping: 'agx',
      fogColor: '#d9c7a4',
      fogDensity: 0.003,
      volumetricFog: 0.018,
      bloom: 0.35,
      contrast: 1.05,
      saturation: 0.95,
      temperature: 0.25,
      vignette: 0.25,
      grain: 0.1,
    },
  ],
});
add('Morning', {
  name: 'Sun',
  active: false,
  rotation: [-35.7, 53.1, 0],
  components: [{ type: 'Light', kind: 'directional', color: '#ffd7a3', intensity: 2.4, castShadow: true }],
});
add('Audio', {
  name: 'Storm',
  components: [{ type: 'AudioSource', ambience: 'storm', volume: 0.55, loop: true, playOnStart: true }],
});
add('Audio', {
  name: 'Rain_Bedroom_Window',
  position: [-5.05, 1.5, -2.0],
  components: [
    {
      type: 'AudioSource',
      ambience: 'rain_window',
      volume: 0.6,
      loop: true,
      playOnStart: true,
      spatial: true,
      range: 5,
    },
  ],
});
add('Audio', {
  name: 'Rain_Kitchen_Window',
  position: [3.15, 1.5, -3.95],
  components: [
    {
      type: 'AudioSource',
      ambience: 'rain_window',
      volume: 0.5,
      loop: true,
      playOnStart: true,
      spatial: true,
      range: 5,
    },
  ],
});
add('Audio', {
  name: 'Fridge_Hum',
  position: [4.73, 1.0, -3.3],
  components: [
    {
      type: 'AudioSource',
      ambience: 'fridge_hum',
      volume: 0.5,
      loop: true,
      playOnStart: true,
      spatial: true,
      range: 6,
    },
  ],
});
add('Audio', {
  name: 'Creaks',
  components: [{ type: 'AudioSource', ambience: 'creaks', volume: 0.25, loop: true, playOnStart: true }],
});
add('Audio', {
  name: 'Birds',
  active: false,
  components: [{ type: 'AudioSource', ambience: 'birds', volume: 0.6, loop: true, playOnStart: true }],
});
// Dust motes in the moonbeam and in the rooms
for (const [name, pos, area, count] of [
  ['Dust_Bedroom', [-3.2, 1.3, -2.0], [3.6, 2.4, 3.6], 450],
  ['Dust_Kitchen', [3.2, 1.3, -1.2], [3.6, 2.4, 4.8], 400],
  ['Dust_Upstairs', [0, U_Y + 1.2, 0], [9, 2.2, 7], 700],
] as [string, V3, V3, number][])
  add('Props', {
    name,
    position: pos,
    components: [
      {
        type: 'ParticleSystem',
        preset: 'dust',
        area,
        count: Math.round(count * 0.5),
        size: 0.004,
        opacity: 0.22,
      },
    ],
  });

// ---------------------------------------------------------------------------------------------------------
// Outside: wet forest floor
// ---------------------------------------------------------------------------------------------------------
slab('Exterior', 'Ground', -40, 40, -40, 40, -0.2, 0.3, 'grass_field');
// Irish fields: drystone walls and windswept thorn trees around the cabin
const fieldWall = (name: string, pos: V3, rotY: number, length: number) =>
  add('Exterior', {
    name,
    position: pos,
    rotation: [0, rotY, 0],
    components: [
      {
        type: 'MeshRenderer',
        model: M('drystone-wall'),
        params: { length, tumble: 0.25 },
        materials: { stones: MAT('stone_lichen') },
      },
      { type: 'Collider', shape: 'auto' },
    ],
  });
fieldWall('Field_Wall_W', [-11, -0.2, -2], 90, 18);
fieldWall('Field_Wall_N', [0, -0.2, -10], 0, 16);
fieldWall('Field_Wall_E', [11, -0.2, 1], 90, 14);
fieldWall('Field_Wall_S', [-5, -0.2, 11], 0, 10);
for (const [name, model, pos, rotY, scale] of [
  ['Thorn_Tree_1', 'island_tree_03', [-8.5, -0.2, -5.5], 40, 0.9],
  ['Thorn_Tree_2', 'island_tree_02', [8.5, -0.2, -7], 200, 0.8],
  ['Thorn_Tree_3', 'island_tree_03', [-7.5, -0.2, 7.5], 120, 0.7],
] as [string, string, V3, number, number][])
  add('Exterior', {
    name,
    position: pos,
    rotation: [0, rotY, 0],
    scale: [scale, scale, scale],
    components: [{ type: 'MeshRenderer', model: `models/polyhaven/${model}.glb` }],
  });

await flush();
await host.save();
const tree = await call<{ tree: string }>('scene_tree', { scene: 'house' });
const lines = String((tree as Record<string, unknown>).tree ?? JSON.stringify(tree)).split('\n');
console.log(`house scene: ${lines.length} lines in scene tree`);
await host.close();

function readFileSafe(rel: string): string | null {
  try {
    return readFileSync(resolve(root, rel), 'utf8');
  } catch {
    return null;
  }
}
