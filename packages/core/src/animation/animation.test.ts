import { describe, expect, it } from 'vitest';
import {
  builtinClip,
  builtinClipNames,
  CLIP_ALIASES,
  canonicalClipName,
  clipTime,
  compileClip,
  emptyPose,
  evaluatePoseState,
  forwardKinematics,
  poseState,
  referenceSkeleton,
  sampleClip,
} from './index.ts';

/** Clip names the Sidle of Milch story scripts and the Godot runtime use. */
const STORY_CLIPS = [
  'idle',
  'walk',
  'run',
  'crouch_walk',
  'lie_asleep',
  'sit_up_bed',
  'stand_up',
  'look_around',
  'scared_breathing',
  'search_drawer',
  'pick_up',
  'reach',
  'examine_object',
  'gasp_startle',
  'faint_collapse',
  'lie_unconscious',
  'wake_on_floor',
  'rub_back',
  'cough',
  'hide_in_belt',
  'scream',
  'open_door',
  'turn_head_left',
  'turn_head_right',
];

const skel = referenceSkeleton();

describe('built-in clip library', () => {
  it('has every story clip under its own name, and aliases resolve to real clips', () => {
    const names = builtinClipNames();
    for (const n of STORY_CLIPS) expect(names, n).toContain(n);
    for (const [alias, target] of Object.entries(CLIP_ALIASES))
      expect(canonicalClipName(alias), alias).toBe(target);
    for (const n of names) {
      const c = builtinClip(n)!;
      expect(c.name).toBe(n);
      if (c.next) expect(canonicalClipName(c.next), `${n}.next`).toBe(c.next);
    }
  });

  it.each(builtinClipNames())('%s samples to unit quaternions everywhere', (name) => {
    const c = compileClip(builtinClip(name)!);
    const pose = emptyPose();
    for (let i = 0; i <= 24; i++) {
      sampleClip(c, (i / 24) * c.duration, pose);
      for (const [bone, q] of Object.entries(pose.rot)) {
        expect(Math.abs(Math.hypot(...q) - 1), `${name} ${bone}`).toBeLessThan(1e-3);
      }
      for (const v of pose.hips) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('looping clips are seamless and one-shots clamp at the end', () => {
    for (const name of builtinClipNames()) {
      const c = compileClip(builtinClip(name)!);
      if (c.loop) {
        const a = sampleClip(c, 0);
        const b = sampleClip(c, c.duration);
        for (const bone of Object.keys(a.rot)) {
          const qa = a.rot[bone]!;
          const qb = b.rot[bone]!;
          const d = Math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]);
          expect(d, `${name} ${bone}`).toBeGreaterThan(0.999);
        }
        expect(clipTime(c, c.duration * 1.5)).toBeCloseTo(c.duration * 0.5, 6);
      } else expect(clipTime(c, c.duration + 5)).toBe(c.duration);
    }
  });

  it('standing clips keep the feet on the floor', () => {
    const standing = [
      'idle',
      'look_around',
      'scared_breathing',
      'gasp_startle',
      'rub_back',
      'examine_object',
      'cough',
    ];
    for (const name of standing) {
      const c = compileClip(builtinClip(name)!);
      for (let i = 0; i <= 12; i++) {
        const pose = evaluatePoseState(poseState(name, (i / 12) * c.duration), () => c);
        const fk = forwardKinematics(skel, pose);
        const low = Math.min(fk.get('foot_l')!.pos[1], fk.get('foot_r')!.pos[1]);
        expect(low, `${name} @${i}`).toBeGreaterThan(0.05);
        expect(low, `${name} @${i}`).toBeLessThan(0.11);
      }
    }
  });

  it('turn_head_left turns toward +X (the character’s left) and the right one mirrors it', () => {
    for (const [name, sign] of [
      ['turn_head_left', 1],
      ['turn_head_right', -1],
    ] as const) {
      const c = compileClip(builtinClip(name)!);
      const fk = forwardKinematics(skel, sampleClip(c, 1.0));
      const q = fk.get('head')!.rot;
      // head forward (+Z) rotated: x component of the new forward vector
      const fx = 2 * (q[0] * q[2] + q[3] * q[1]);
      expect(fx * sign, name).toBeGreaterThan(0.5);
    }
  });
});
