/**
 * MakeHuman -> AIGE humanoid. tools/makehuman/build_human.py builds a realistic human from the MakeHuman CC0
 * base in Blender (MPFB) and exports it skinned to MakeHuman's "default" rig (arms ~47 degrees down, close to the
 * AIGE A-pose) with facial expression blend shapes.
 * This maps that rig onto the AIGE humanoid skeleton (identity bind rotations, the 29 AIGE bones), merges the
 * vertex weights, and returns a Model with the built-in clips, sockets and a collider, like humanoid() does.
 */
import { HUMANOID_ARM_ANGLE } from '@aige/core';
import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import type { V2, V3 } from '../math.ts';
import { type Joint, Model } from '../model.ts';
import { PolyMesh } from '../polymesh.ts';
import { animateFingers, builtinAnimations, builtinClipAliases } from './animation.ts';
import { type MocapOptions, mocapAnimation, parseBvh, sliceAnimation } from './mocap.ts';

/** Where each AIGE joint sits: the head of this MakeHuman "default" rig bone. */
const JOINT_AT: Record<string, string> = {
  hips: 'spine05',
  spine: 'spine04',
  chest: 'spine02',
  neck: 'neck01',
  head: 'head',
  jaw: 'jaw',
  eye_l: 'eye.L',
  eye_r: 'eye.R',
  shoulder_l: 'clavicle.L',
  upperarm_l: 'upperarm01.L',
  forearm_l: 'lowerarm01.L',
  hand_l: 'wrist.L',
  fingers_l: 'finger3-1.L',
  fingertips_l: 'finger3-2.L',
  thumb_l: 'finger1-1.L',
  shoulder_r: 'clavicle.R',
  upperarm_r: 'upperarm01.R',
  forearm_r: 'lowerarm01.R',
  hand_r: 'wrist.R',
  fingers_r: 'finger3-1.R',
  fingertips_r: 'finger3-2.R',
  thumb_r: 'finger1-1.R',
  thigh_l: 'upperleg01.L',
  shin_l: 'lowerleg01.L',
  foot_l: 'foot.L',
  toe_l: 'toe3-1.L',
  thigh_r: 'upperleg01.R',
  shin_r: 'lowerleg01.R',
  foot_r: 'foot.R',
  toe_r: 'toe3-1.R',
  // separate fingers (the clip baker derives them from the hand's curl)
  index_l: 'finger2-1.L',
  index_tip_l: 'finger2-2.L',
  ring_l: 'finger4-1.L',
  ring_tip_l: 'finger4-2.L',
  pinky_l: 'finger5-1.L',
  pinky_tip_l: 'finger5-2.L',
  index_r: 'finger2-1.R',
  index_tip_r: 'finger2-2.R',
  ring_r: 'finger4-1.R',
  ring_tip_r: 'finger4-2.R',
  pinky_r: 'finger5-1.R',
  pinky_tip_r: 'finger5-2.R',
};

const PARENT: Record<string, string | null> = {
  hips: null,
  spine: 'hips',
  chest: 'spine',
  neck: 'chest',
  head: 'neck',
  jaw: 'head',
  eye_l: 'head',
  eye_r: 'head',
  shoulder_l: 'chest',
  upperarm_l: 'shoulder_l',
  forearm_l: 'upperarm_l',
  hand_l: 'forearm_l',
  fingers_l: 'hand_l',
  fingertips_l: 'fingers_l',
  thumb_l: 'hand_l',
  shoulder_r: 'chest',
  upperarm_r: 'shoulder_r',
  forearm_r: 'upperarm_r',
  hand_r: 'forearm_r',
  fingers_r: 'hand_r',
  fingertips_r: 'fingers_r',
  thumb_r: 'hand_r',
  thigh_l: 'hips',
  shin_l: 'thigh_l',
  foot_l: 'shin_l',
  toe_l: 'foot_l',
  thigh_r: 'hips',
  shin_r: 'thigh_r',
  foot_r: 'shin_r',
  toe_r: 'foot_r',
  index_l: 'hand_l',
  index_tip_l: 'index_l',
  ring_l: 'hand_l',
  ring_tip_l: 'ring_l',
  pinky_l: 'hand_l',
  pinky_tip_l: 'pinky_l',
  index_r: 'hand_r',
  index_tip_r: 'index_r',
  ring_r: 'hand_r',
  ring_tip_r: 'ring_r',
  pinky_r: 'hand_r',
  pinky_tip_r: 'pinky_r',
};

/**
 * The AIGE bone that takes a MakeHuman bone's weights. `lowerLip` names the lip bones below the mouth line,
 * which follow the jaw so the mouth opens.
 */
export function makeHumanBone(name: string, lowerLip: ReadonlySet<string> = new Set()): string {
  const side = name.endsWith('.L') ? '_l' : name.endsWith('.R') ? '_r' : '';
  const b = name.replace(/\.[LR]$/, '');
  if (b === 'root' || b === 'spine05' || b === 'pelvis') return 'hips';
  if (b === 'spine04' || b === 'spine03') return 'spine';
  if (b === 'spine02' || b === 'spine01' || b === 'breast') return 'chest';
  if (b.startsWith('neck')) return 'neck';
  if (b === 'jaw' || b.startsWith('tongue') || lowerLip.has(name)) return 'jaw';
  if (b === 'eye') return `eye${side}`; // the runtime moves the eyes (saccades)
  if (b === 'clavicle') return `shoulder${side}`;
  if (b === 'shoulder01' || b.startsWith('upperarm')) return `upperarm${side}`;
  if (b.startsWith('lowerarm')) return `forearm${side}`;
  if (b === 'wrist' || b.startsWith('metacarpal')) return `hand${side}`;
  if (b.startsWith('finger1-')) return `thumb${side}`;
  const finger = /^finger([2-5])-([123])$/.exec(b);
  if (finger) {
    const f = ({ '2': 'index', '3': '', '4': 'ring', '5': 'pinky' } as Record<string, string>)[finger[1]!]!;
    const tip = finger[2] !== '1';
    return f ? `${f}${tip ? '_tip' : ''}${side}` : `${tip ? 'fingertips' : 'fingers'}${side}`;
  }
  if (b.startsWith('upperleg')) return `thigh${side}`;
  if (b.startsWith('lowerleg')) return `shin${side}`;
  if (b === 'foot') return `foot${side}`;
  if (b.startsWith('toe')) return `toe${side}`;
  return 'head'; // eyes, lids, brows, cheeks, upper lip
}

export interface MakeHumanOptions {
  /** Part name per exported mesh name (e.g. 'Human.short02' -> 'hair'); unmatched meshes keep a cleaned name. */
  parts?: Record<string, string>;
  /** Parts that take the body's facial blend shapes by proximity (default: brows and lashes). */
  followMorphs?: RegExp;
  /** Built-in clips to include: 'all' (default), 'none' or a list. */
  clips?: 'all' | 'none' | string[];
  /** Motion-capture takes (BVH text, CMU skeleton) that replace or add clips by name. */
  mocap?: (MocapOptions & { bvh: string })[];
  /** New clips cut from others (built-in or mocap), e.g. the leg swing at the end of a keyframed wake-up. */
  slices?: { name: string; of: string; from: number; to: number; loop?: boolean; next?: string }[];
}

/** Converts a skinned MakeHuman GLB (tools/makehuman/build_human.py) into an AIGE humanoid Model. */
export async function humanoidFromMakeHuman(glb: Uint8Array, opts: MakeHumanOptions = {}): Promise<Model> {
  const doc = await new WebIO().registerExtensions(ALL_EXTENSIONS).readBinary(glb);
  const skin = doc.getRoot().listSkins()[0];
  if (!skin) throw new Error('The GLB has no skin; export it from build_human.py.');
  const src = skin.listJoints();
  const pos = new Map(src.map((j) => [j.getName(), j.getWorldTranslation() as unknown as V3]));
  // lip bones below the mouth line follow the jaw
  const lips = [...pos].filter(([n]) => n.startsWith('oris'));
  const mouthY = lips.reduce((s, [, p]) => s + p[1], 0) / Math.max(1, lips.length);
  const lowerLip = new Set(lips.filter(([, p]) => p[1] < mouthY - 0.002).map(([n]) => n));

  const joints: Joint[] = Object.keys(PARENT).map((name) => {
    const at = pos.get(JOINT_AT[name]!);
    if (!at) throw new Error(`MakeHuman bone ${JOINT_AT[name]} is missing (use the "default" rig).`);
    return { name, parent: PARENT[name]!, position: [at[0], at[1], at[2]] };
  });
  const index = new Map(joints.map((j, i) => [j.name, i]));
  const remap = src.map((j) => index.get(makeHumanBone(j.getName(), lowerLip))!);

  const model = new Model();
  model.skeleton = { joints };
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || !node.getSkin()) continue;
    const raw = node.getName();
    const base =
      opts.parts?.[raw] ??
      (raw === 'Human' ? 'body' : raw.replace(/^Human\./, '').replace(/[^A-Za-z0-9_]/g, '_'));
    mesh.listPrimitives().forEach((prim, pi) => {
      const P = prim.getAttribute('POSITION')?.getArray();
      const UV = prim.getAttribute('TEXCOORD_0')?.getArray();
      const J = prim.getAttribute('JOINTS_0')?.getArray();
      const W = prim.getAttribute('WEIGHTS_0')?.getArray();
      const I = prim.getIndices()?.getArray();
      if (!P || !J || !W) return;
      const n = P.length / 3;
      const positions: V3[] = [];
      for (let v = 0; v < n; v++) positions.push([P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!]);
      const tris: number[][] = [];
      const idx = I ?? Array.from({ length: n }, (_, k) => k);
      for (let t = 0; t + 2 < idx.length; t += 3) tris.push([idx[t]!, idx[t + 1]!, idx[t + 2]!]);
      const m = PolyMesh.fromPolygons(positions, tris);
      if (UV) for (const f of m.f) f.uv = f.v.map((k) => [UV[k * 2]!, 1 - UV[k * 2 + 1]!] as V2);
      // merge the MakeHuman influences per AIGE bone, keep the 4 strongest, renormalize
      const joints4 = new Uint16Array(n * 4);
      const weights4 = new Float32Array(n * 4);
      for (let v = 0; v < n; v++) {
        const acc = new Map<number, number>();
        for (let k = 0; k < 4; k++) {
          const w = W[v * 4 + k]!;
          if (w > 0) acc.set(remap[J[v * 4 + k]!]!, (acc.get(remap[J[v * 4 + k]!]!) ?? 0) + w);
        }
        const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
        const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
        top.forEach(([j, w], k) => {
          joints4[v * 4 + k] = j;
          weights4[v * 4 + k] = w / sum;
        });
        if (!top.length) weights4[v * 4] = 1; // unweighted vertex: pin to the hips
      }
      // facial blend shapes (MakeHuman expression units) come through as morph targets
      const names = (mesh.getExtras() as { targetNames?: string[] }).targetNames ?? [];
      const morphs = prim.listTargets().flatMap((target, ti) => {
        const d = target.getAttribute('POSITION')?.getArray();
        return d ? [{ name: names[ti] ?? `shape${ti}`, deltas: new Float32Array(d) }] : [];
      });
      model.add(m, pi ? `${base}_${pi}` : base, { joints: joints4, weights: weights4 }, morphs);
    });
  }

  followFaceMorphs(model, opts.followMorphs ?? /brow|lash/);

  const at = (name: string) => joints[index.get(name)!]!.position;
  const height = Math.max(...model.parts.flatMap((p) => p.mesh.p.map((v) => v[1])));
  for (const [side, t] of [
    [1, 'l'],
    [-1, 'r'],
  ] as const) {
    const h = at(`hand_${t}`);
    const f = at(`fingers_${t}`);
    model.socket(
      `hand_${t}`,
      [(h[0] + f[0]) / 2, (h[1] + f[1]) / 2 - 0.015, (h[2] + f[2]) / 2],
      [0, 0, side * -HUMANOID_ARM_ANGLE],
      `hand_${t}`,
    );
  }
  model.socket('head', [0, height + 0.01, 0], [0, 0, 0], 'head');
  const head = at('head');
  model.socket('eyes', [0, head[1] + 0.1, head[2] + 0.1], [0, 0, 0], 'head');
  const hips = at('hips');
  model.socket('belt', [0.05, hips[1] + 0.02, hips[2] + 0.13], [0, 0, 0], 'hips');
  const chest = at('chest');
  model.socket('back', [0, chest[1] + 0.05, chest[2] - 0.17], [0, 0, 0], 'chest');
  model.setCollider({ shape: 'capsule', radius: 0.2, height, offset: [0, height / 2, 0] });
  model.smoothAngle = 85;
  model.animations = builtinAnimations(model.skeleton, opts.clips ?? 'all');
  // slices come from the built-in clips, before mocap takes replace any of them
  for (const sl of opts.slices ?? []) {
    const src = model.animations.find((a) => a.name === sl.of);
    if (!src) throw new Error(`Slice ${sl.name}: no clip ${sl.of}.`);
    const cut = sliceAnimation(src, sl.from, sl.to, sl.name, sl);
    model.animations = [...model.animations.filter((a) => a.name !== sl.name), cut];
  }
  if (opts.mocap?.length) {
    // fingers keep the relaxed curl of the built-in idle (captures have no fingers), then flex on their own
    const idle = model.animations.find((a) => a.name === 'idle');
    const hold = new Map<string, [number, number, number, number]>();
    for (const ch of idle?.channels ?? [])
      if (ch.path === 'rotation' && /^(fingers|fingertips|thumb)_/.test(ch.joint))
        hold.set(ch.joint, [ch.values[0]!, ch.values[1]!, ch.values[2]!, ch.values[3]!]);
    for (const m of opts.mocap) {
      const anim = animateFingers(mocapAnimation(parseBvh(m.bvh), model.skeleton, m, hold), model.skeleton);
      model.animations = [...model.animations.filter((a) => a.name !== m.name), anim];
    }
  }

  if (model.animations.length) model.clipAliases = builtinClipAliases();
  return model;
}

/**
 * Gives parts that sit on the face (eyebrows, lashes) the body's blend shapes: each vertex copies the deltas of
 * the nearest face vertices (inverse-distance over the 3 closest), so brows rise and lashes close with the lids.
 */
function followFaceMorphs(model: Model, pattern: RegExp): void {
  const body = model.parts.find((p) => p.morphs?.length);
  if (!body?.morphs) return;
  const morphs = body.morphs;
  // candidate vertices: the ones any blend shape moves
  const moving: number[] = [];
  for (let v = 0; v < body.mesh.p.length; v++)
    if (
      morphs.some(
        (m) =>
          Math.abs(m.deltas[v * 3]!) + Math.abs(m.deltas[v * 3 + 1]!) + Math.abs(m.deltas[v * 3 + 2]!) > 1e-6,
      )
    )
      moving.push(v);
  for (const part of model.parts) {
    if (part === body || part.morphs?.length || !pattern.test(part.name)) continue;
    const n = part.mesh.p.length;
    const out = morphs.map((m) => ({ name: m.name, deltas: new Float32Array(n * 3) }));
    for (let v = 0; v < n; v++) {
      const p = part.mesh.p[v]!;
      const best: [number, number][] = [];
      for (const b of moving) {
        const q = body.mesh.p[b]!;
        const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (best.length < 3 || d < best[2]![0]) {
          best.push([d, b]);
          best.sort((a, c) => a[0] - c[0]);
          if (best.length > 3) best.pop();
        }
      }
      // too far from anything that moves (more than 3 cm): leave it still
      if (!best.length || best[0]![0] > 0.03 ** 2) continue;
      const w = best.map(([d]) => 1 / (Math.sqrt(d) + 1e-4));
      const sum = w.reduce((s, x) => s + x, 0);
      morphs.forEach((m, mi) => {
        for (let k = 0; k < 3; k++) {
          let acc = 0;
          best.forEach(([, b], i) => {
            acc += m.deltas[b * 3 + k]! * w[i]!;
          });
          out[mi]!.deltas[v * 3 + k] = acc / sum;
        }
      });
    }
    part.morphs = out;
  }
}
