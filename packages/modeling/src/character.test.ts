import { builtinClip, HUMANOID_BONES } from '@aige/core';
import { WebIO } from '@gltf-transform/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { clipToModelAnimation } from './character/animation.ts';
import { exportGlb, humanoid, initModeling, type Model, readGlbSkeleton } from './index.ts';

let model: Model;

beforeAll(async () => {
  await initModeling();
  model = humanoid({ preset: 'murphy', detail: 'low', clips: ['idle', 'walk', 'faint'] });
}, 60_000);

describe('humanoid()', () => {
  it('has the AIGE humanoid skeleton, parents first', () => {
    const names = model.skeleton!.joints.map((j) => j.name);
    expect(new Set(names)).toEqual(new Set(HUMANOID_BONES));
    const seen = new Set<string>();
    for (const j of model.skeleton!.joints) {
      if (j.parent) expect(seen.has(j.parent), `${j.name} after ${j.parent}`).toBe(true);
      seen.add(j.name);
    }
    const hips = model.skeleton!.joints.find((j) => j.name === 'hips')!;
    expect(hips.position[1]).toBeGreaterThan(0.6);
    expect(hips.position[1]).toBeLessThan(0.85);
    expect(model.bounds().max[1]).toBeGreaterThan(1.35);
    expect(model.bounds().max[1]).toBeLessThan(1.47);
  });

  it('skins every part with valid, normalized weights (max 4 influences)', () => {
    const jointCount = model.skeleton!.joints.length;
    for (const part of model.parts) {
      const skin = part.skin!;
      expect(skin, part.name).toBeDefined();
      expect(skin.joints.length).toBe(part.mesh.p.length * 4);
      expect(skin.weights.length).toBe(part.mesh.p.length * 4);
      for (let v = 0; v < part.mesh.p.length; v++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          const w = skin.weights[v * 4 + k]!;
          expect(w).toBeGreaterThanOrEqual(0);
          expect(skin.joints[v * 4 + k]!).toBeLessThan(jointCount);
          sum += w;
        }
        expect(Math.abs(sum - 1), `${part.name} vertex ${v}`).toBeLessThan(1e-4);
      }
    }
  });

  it('weights follow anatomy: eyes on the head, the jaw moves the chin, hands on the hand chain', () => {
    const idx = (n: string) => model.skeleton!.joints.findIndex((j) => j.name === n);
    const eyes = model.parts.find((p) => p.name === 'eyes')!;
    expect([...new Set(eyes.skin!.joints.filter((_, i) => eyes.skin!.weights[i]! > 0))]).toEqual([
      idx('head'),
    ]);
    const head = model.parts.find((p) => p.name === 'skin_head')!;
    const jaw = idx('jaw');
    let jawVerts = 0;
    head.skin!.joints.forEach((j, i) => {
      if (j === jaw && head.skin!.weights[i]! > 0.5) jawVerts++;
    });
    expect(jawVerts).toBeGreaterThan(20);
    // the outermost fingertip belongs to the hand chain
    const arms = model.parts.find((p) => p.name === 'skin_arms')!;
    const tipX = Math.max(...arms.mesh.p.map((p) => p[0]));
    const tip = arms.mesh.p.findIndex((p) => p[0] === tipX);
    const handChain = ['hand_l', 'fingers_l', 'fingertips_l', 'thumb_l'].map(idx);
    expect(handChain).toContain(arms.skin!.joints[tip * 4]!);
  });

  it('bakes clips with hips translation scaled to the character', () => {
    const walk = model.animations.find((a) => a.name === 'walk')!;
    expect(walk.loop).toBe(true);
    const hips = walk.channels.find((c) => c.joint === 'hips' && c.path === 'translation')!;
    const bindY = model.skeleton!.joints.find((j) => j.name === 'hips')!.position[1];
    expect(Math.abs(hips.values[1]! - bindY)).toBeLessThan(0.1);
    for (const c of walk.channels)
      for (let i = 1; i < c.times.length; i++) expect(c.times[i]!).toBeGreaterThan(c.times[i - 1]!);
    const anim = clipToModelAnimation(builtinClip('faint')!, model.skeleton!);
    expect(anim.name).toBe('faint_collapse');
    expect(anim.next).toBe('lie_unconscious');
  });
});

describe('glTF skin + animation round trip', () => {
  it('writes joints, skins, JOINTS_0/WEIGHTS_0, sockets on bones and one animation per clip', async () => {
    const glb = await exportGlb(model);
    const doc = await new WebIO().readBinary(glb);
    const root = doc.getRoot();
    const skins = root.listSkins();
    expect(skins.length).toBe(1);
    const joints = skins[0]!.listJoints().map((n) => n.getName());
    expect(joints).toEqual(model.skeleton!.joints.map((j) => j.name));
    expect(skins[0]!.getInverseBindMatrices()!.getCount()).toBe(joints.length);
    let skinnedNodes = 0;
    for (const node of root.listNodes()) {
      const mesh = node.getMesh();
      if (!mesh) continue;
      expect(node.getSkin(), node.getName()).toBe(skins[0]);
      skinnedNodes++;
      for (const prim of mesh.listPrimitives()) {
        const j = prim.getAttribute('JOINTS_0')!;
        const w = prim.getAttribute('WEIGHTS_0')!;
        expect(j.getCount()).toBe(prim.getAttribute('POSITION')!.getCount());
        const wa = w.getArray()!;
        const ja = j.getArray()!;
        for (let v = 0; v < w.getCount(); v++) {
          expect(Math.abs(wa[v * 4]! + wa[v * 4 + 1]! + wa[v * 4 + 2]! + wa[v * 4 + 3]! - 1)).toBeLessThan(
            1e-3,
          );
          for (let k = 0; k < 4; k++) expect(ja[v * 4 + k]!).toBeLessThan(joints.length);
        }
      }
    }
    expect(skinnedNodes).toBe(model.parts.length);
    const socket = root.listNodes().find((n) => n.getName() === 'socket:hand_r')!;
    expect(socket.getParentNode()?.getName()).toBe('hand_r');
    const anims = root.listAnimations();
    expect(anims.map((a) => a.getName()).sort()).toEqual(['faint_collapse', 'idle', 'walk']);
    const walk = anims.find((a) => a.getName() === 'walk')!;
    const paths = walk.listChannels().map((c) => `${c.getTargetNode()!.getName()}.${c.getTargetPath()}`);
    expect(paths).toContain('hips.translation');
    expect(paths).toContain('thigh_l.rotation');
    const input = walk.listSamplers()[0]!.getInput()!;
    expect(input.getMax([0])[0]).toBeCloseTo(builtinClip('walk')!.duration, 3);
    const extras = doc.getRoot().listScenes()[0]!.listChildren()[0]!.getExtras() as {
      aige: { clips: { name: string; loop: boolean }[]; clipAliases: Record<string, string> };
    };
    expect(extras.aige.clips.find((c) => c.name === 'idle')?.loop).toBe(true);
    expect(extras.aige.clipAliases.faint).toBe('faint_collapse');
    const skel = await readGlbSkeleton(glb);
    const bind = new Map(model.skeleton!.joints.map((j) => [j.name, j.position]));
    for (const j of skel!.joints) {
      const p = bind.get(j.name)!;
      expect(Math.hypot(p[0] - j.position[0], p[1] - j.position[1], p[2] - j.position[2])).toBeLessThan(1e-5);
    }
  }, 30_000);
});
