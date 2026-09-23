/**
 * Built-in procedural humanoid clip library. Every clip is generated in code (key poses + procedural overlays,
 * baked to 30 fps keyframes) on the reference skeleton, so it plays on any humanoid made with humanoid().
 *
 * Placement conventions (so clips chain in cutscenes without popping):
 * - the entity origin is where the character stands; standing clips keep the feet there;
 * - bed clips: the bed is behind the character (toward -Z) with its mattress top at knee height (0.46 m for the
 *   reference adult); lying in bed the body runs along X (head toward -X, his right) about 0.75 m behind the
 *   origin; sitting on the edge the feet are at the origin and the hips ~0.42 m behind;
 * - floor clips: `faint` collapses backward; lying on the floor the head points toward -Z and the hips are
 *   ~0.4 m behind the origin; `wake_up_floor` ends standing at the origin.
 */

import { addTo, bake, bump, cyclic, type Key, keyed, loopNoise, mergePose, ramp } from './author.ts';
import type { AnimClip } from './clip.ts';
import type { V3 } from './quat.ts';
import { type ArmPose, type BodyPose, evaluateBodyPose, type LegPose, REF } from './rig.ts';
import { forwardKinematics } from './skeleton.ts';

/** Mattress / seat height the bed clips assume for the reference adult (scaled with hip height). */
export const BED_TOP = 0.46;

// ---------------------------------------------------------------------------------------------
// Shared poses
// ---------------------------------------------------------------------------------------------

const FOOT_Y = 0.08;
const legIK = (x: number, z = 0, extra: LegPose = {}): LegPose => ({
  ik: [x, FOOT_Y, z],
  ikw: 1,
  flat: 1,
  twist: 6,
  ...extra,
});

const ARM_REST: ArmPose = {
  shrug: 0,
  reach: 0,
  down: 44,
  fwd: 4,
  across: 0,
  twist: 0,
  elbow: 14,
  ftwist: 0,
  wrist: 4,
  wside: 0,
  fingers: 24,
  thumb: 14,
};

export const STAND: BodyPose = {
  pos: [0, -0.01, 0],
  hips: [0, 0, 0],
  spine: [1.5, 0, 0],
  chest: [-1, 0, 0],
  neck: [6, 0, 0],
  head: [-5, 0, 0],
  jaw: 0,
  armL: { ...ARM_REST },
  armR: { ...ARM_REST },
  legL: legIK(0.1),
  legR: legIK(-0.1),
};

/** Breathing overlay: chest/shoulder rise and a tiny head counter-motion. */
function breathe(p: BodyPose, t: number, period: number, amount = 1, phase = 0): BodyPose {
  const b = Math.sin((2 * Math.PI * (t + phase)) / period);
  // inhale is a little quicker than exhale
  const s = b > 0 ? b ** 0.8 : -((-b) ** 1.2);
  addTo(p, 'chest.0', -1.4 * s * amount);
  addTo(p, 'spine.0', -0.5 * s * amount);
  addTo(p, 'neck.0', 0.9 * s * amount);
  addTo(p, 'armL.shrug', 1.2 * s * amount);
  addTo(p, 'armR.shrug', 1.2 * s * amount);
  addTo(p, 'armL.down', -0.6 * s * amount);
  addTo(p, 'armR.down', -0.6 * s * amount);
  return p;
}

/** Subtle idle life: weight shift and small head drift, all loop-safe over `period`. */
function idleLife(p: BodyPose, t: number, period: number, amount = 1, seed = 1): BodyPose {
  const w = loopNoise(t, period, seed, 2);
  addTo(p, 'pos.0', 0.012 * w * amount);
  addTo(p, 'pos.1', -0.004 * Math.abs(w) * amount);
  addTo(p, 'hips.2', 1.6 * w * amount);
  addTo(p, 'chest.2', -1.1 * w * amount);
  addTo(p, 'head.1', 4 * loopNoise(t, period, seed + 3, 3) * amount);
  addTo(p, 'head.0', 2 * loopNoise(t, period, seed + 7, 2) * amount);
  addTo(p, 'armL.fwd', 1.5 * loopNoise(t, period, seed + 11, 2) * amount);
  addTo(p, 'armR.fwd', 1.5 * loopNoise(t, period, seed + 13, 2) * amount);
  return p;
}

const clone = (p: BodyPose): BodyPose => JSON.parse(JSON.stringify(p)) as BodyPose;

// ---------------------------------------------------------------------------------------------
// Locomotion
// ---------------------------------------------------------------------------------------------

function idle(): AnimClip {
  const T = 9.6;
  return bake(
    {
      name: 'idle',
      description: 'Relaxed standing idle: slow breathing, gentle weight shifts, small head drift. Loops.',
      duration: T,
      loop: true,
    },
    (t) => idleLife(breathe(clone(STAND), t, T / 3, 1), t, T, 1, 2),
  );
}

function idleNervous(): AnimClip {
  const T = 7.2;
  const base = mergePose(STAND, {
    pos: [0, -0.03, 0],
    spine: [5, 0, 0],
    chest: [2, 0, 0],
    neck: [4, 0, 0],
    head: [-2, 0, 0],
    armL: { shrug: 5, reach: 3, down: 47, fwd: 10, elbow: 32, fingers: 40, thumb: 25, twist: 8 },
    armR: { shrug: 5, reach: 3, down: 47, fwd: 10, elbow: 30, fingers: 40, thumb: 25, twist: 8 },
  });
  // quick glances: head holds, then snaps to a new direction
  const glance = cyclic([
    [0, 0],
    [0.12, 0],
    [0.17, 28],
    [0.33, 30],
    [0.38, -8],
    [0.52, -6],
    [0.57, -34],
    [0.72, -30],
    [0.77, 4],
    [0.92, 2],
  ]);
  return bake(
    {
      name: 'idle_nervous',
      description:
        'Tense standing idle: raised shoulders, quick shallow breaths, darting glances, fidgeting fingers. Loops.',
      duration: T,
      loop: true,
    },
    (t) => {
      const p = breathe(clone(base), t, T / 5, 1.3);
      idleLife(p, t, T, 1.4, 5);
      const g = glance(t / T);
      addTo(p, 'head.1', g * 0.75);
      addTo(p, 'neck.1', g * 0.25);
      addTo(p, 'chest.1', g * 0.12);
      addTo(p, 'armL.fingers', 18 * loopNoise(t, T / 3, 4, 2));
      addTo(p, 'armR.fingers', 18 * loopNoise(t, T / 3, 9, 2));
      addTo(p, 'armL.thumb', 12 * loopNoise(t, T / 4, 5, 2));
      return p;
    },
  );
}

interface GaitCurves {
  hip: (ph: number) => number;
  knee: (ph: number) => number;
  ankle: (ph: number) => number;
}

const WALK: GaitCurves = {
  hip: cyclic([
    [0, 24],
    [0.12, 20],
    [0.3, 6],
    [0.5, -12],
    [0.6, -6],
    [0.75, 18],
    [0.87, 27],
  ]),
  knee: cyclic([
    [0, 4],
    [0.14, 17],
    [0.38, 5],
    [0.5, 10],
    [0.6, 36],
    [0.72, 60],
    [0.86, 28],
    [0.96, 5],
  ]),
  ankle: cyclic([
    [0, 2],
    [0.07, -6],
    [0.25, 4],
    [0.45, 10],
    [0.62, -17],
    [0.76, 0],
    [0.9, 3],
  ]),
};

const RUN: GaitCurves = {
  hip: cyclic([
    [0, 32],
    [0.18, 12],
    [0.38, -16],
    [0.5, -8],
    [0.7, 40],
    [0.84, 50],
  ]),
  knee: cyclic([
    [0, 18],
    [0.14, 38],
    [0.38, 18],
    [0.55, 70],
    [0.7, 112],
    [0.86, 55],
    [0.96, 24],
  ]),
  ankle: cyclic([
    [0, 6],
    [0.14, 16],
    [0.38, -24],
    [0.55, -12],
    [0.75, 4],
    [0.92, 8],
  ]),
};

/** Horizontal speed (m/s, reference skeleton) implied by a gait: stance-foot travel per stance time. */
function gaitSpeed(g: GaitCurves, T: number, a: number, b: number): number {
  const ankleZ = (ph: number) => {
    const e = evaluateBodyPose({ legL: { flex: g.hip(ph), knee: g.knee(ph), ankle: g.ankle(ph) } });
    const fk = forwardKinematics(REF, e);
    return fk.get('foot_l')!.pos[2] - fk.get('hips')!.pos[2];
  };
  return (ankleZ(a) - ankleZ(b)) / ((b - a) * T);
}

function gait(
  name: string,
  description: string,
  T: number,
  g: GaitCurves,
  o: { lean: number; armSwing: number; elbow: number; elbowSwing: number; pelvisYaw: number; flight: number },
): AnimClip {
  const clip = bake({ name, description, duration: T, loop: true }, (t) => {
    const ph = t / T;
    const c = Math.cos(2 * Math.PI * ph);
    const s = Math.sin(2 * Math.PI * ph);
    const pelvisYaw = -o.pelvisYaw * c;
    const p: BodyPose = {
      hips: [o.lean * 0.3, pelvisYaw, 2.5 * s],
      pos: [0.018 * s * (1 - o.flight), 0, 0],
      spine: [o.lean * 0.4, -pelvisYaw * 0.6, -1.2 * s],
      chest: [o.lean * 0.3 - 1, -pelvisYaw * 1.2, -1.2 * s],
      neck: [4 - o.lean * 0.4, pelvisYaw * 0.3, 0.6 * s],
      head: [-3 - o.lean * 0.3, pelvisYaw * 0.35, 0.6 * s],
      legL: { flex: g.hip(ph), knee: g.knee(ph), ankle: g.ankle(ph), twist: 5, abd: 0.5 },
      legR: {
        flex: g.hip(ph + 0.5),
        knee: g.knee(ph + 0.5),
        ankle: g.ankle(ph + 0.5),
        twist: 5,
        abd: 0.5,
      },
      ground: 0,
      contacts: ['feet'],
      lift: o.flight * 0.045 * (bump(ph, 0.44, 0.1) + bump(ph, 0.94, 0.1) + bump(ph, -0.06, 0.1)),
    };
    // arms swing opposite to the legs, with a little lag (follow-through)
    const ap = (d: number) => Math.cos(2 * Math.PI * (ph - 0.04 + d));
    const swingL = -ap(0);
    const swingR = -ap(0.5);
    p.armL = {
      ...ARM_REST,
      down: 43 + o.flight * 2,
      fwd: 4 + o.armSwing * swingL,
      across: o.flight * 8 * Math.max(0, swingL),
      elbow: o.elbow + o.elbowSwing * Math.max(0, swingL),
      fingers: 28 + o.flight * 30,
    };
    p.armR = {
      ...ARM_REST,
      down: 43 + o.flight * 2,
      fwd: 4 + o.armSwing * swingR,
      across: o.flight * 8 * Math.max(0, swingR),
      elbow: o.elbow + o.elbowSwing * Math.max(0, swingR),
      fingers: 28 + o.flight * 30,
    };
    return p;
  });
  return clip;
}

function walk(): AnimClip {
  const T = 1.08;
  const c = gait(
    'walk',
    'Natural walk cycle in place (heel strike, toe off, pelvis rotation and list, counter-rotating chest and arm swing). Loops; locomotion plays it faster/slower to match speed.',
    T,
    WALK,
    { lean: 3, armSwing: 15, elbow: 16, elbowSwing: 12, pelvisYaw: 4.5, flight: 0 },
  );
  c.speed = Math.round(gaitSpeed(WALK, T, 0.04, 0.46) * 100) / 100;
  return c;
}

function run(): AnimClip {
  const T = 0.7;
  const c = gait(
    'run',
    'Running cycle in place with a flight phase, forward lean and pumping bent arms. Loops.',
    T,
    RUN,
    { lean: 11, armSwing: 32, elbow: 78, elbowSwing: 18, pelvisYaw: 7, flight: 1 },
  );
  c.speed = Math.round(gaitSpeed(RUN, T, 0.02, 0.34) * 100) / 100;
  return c;
}

// ---------------------------------------------------------------------------------------------
// Bed
// ---------------------------------------------------------------------------------------------

const LIE_BED: BodyPose = {
  pos: [0.12, 0, -0.78],
  hips: [-90, 90, 0],
  spine: [-2, 0, 0],
  chest: [-2, 0, 0],
  neck: [16, 6, 0],
  head: [8, 18, 4],
  jaw: 2,
  armL: { ...ARM_REST, down: 40, fwd: 18, elbow: 58, twist: 30, fingers: 34, wrist: 8 },
  armR: { ...ARM_REST, down: 36, fwd: 4, elbow: 22, fingers: 30, twist: -10 },
  legL: { flex: 8, knee: 14, ankle: -18, twist: 16, abd: 2 },
  legR: { flex: 14, knee: 24, ankle: -16, twist: 10, abd: -1 },
  ground: BED_TOP,
  contacts: ['back', 'sit', 'head'],
};

/** Sitting on the bed edge: feet at the origin, hips ~0.42 m behind. */
const SIT_EDGE: BodyPose = {
  pos: [0, 0, -0.42],
  hips: [-8, 0, 0],
  spine: [10, 0, 0],
  chest: [6, 0, 0],
  neck: [8, 0, 0],
  head: [6, 0, 0],
  armL: { ...ARM_REST, ik: [0.19, 0.6, -0.16], ikw: 1, wrist: -30, fingers: 30, ftwist: -10 },
  armR: { ...ARM_REST, ik: [-0.19, 0.6, -0.16], ikw: 1, wrist: -30, fingers: 30, ftwist: -10 },
  legL: { flex: 80, knee: 84, ik: [0.13, FOOT_Y, -0.02], ikw: 1, flat: 1, twist: 8 },
  legR: { flex: 80, knee: 84, ik: [-0.12, FOOT_Y, -0.05], ikw: 1, flat: 1, twist: 8 },
  ground: BED_TOP,
  contacts: ['sit'],
};

function lieAsleep(): AnimClip {
  const T = 10;
  return bake(
    {
      name: 'lie_asleep',
      description:
        'Asleep on the back in bed: slow deep breathing, head turned on the pillow, one hand on the belly. The body lies along X (head toward -X) about 0.75 m behind the origin on a knee-high bed. Loops.',
      duration: T,
      loop: true,
      setting: 'bed',
    },
    (t) => {
      const p = clone(LIE_BED);
      breathe(p, t, T / 2, 1.3);
      addTo(p, 'head.1', 2 * loopNoise(t, T, 3, 2));
      addTo(p, 'armL.elbow', 3 * Math.sin((2 * Math.PI * t) / (T / 2)));
      return p;
    },
  );
}

function sitUpInBed(): AnimClip {
  const sitInBed: BodyPose = {
    pos: [0.1, 0, -0.74],
    hips: [-16, 90, 0],
    spine: [14, 0, 0],
    chest: [8, 0, 0],
    neck: [4, 0, 0],
    head: [0, 0, 0],
    armL: { ...ARM_REST, down: 36, fwd: -24, elbow: 8, wrist: -60, fingers: 12, twist: -20 },
    armR: { ...ARM_REST, down: 36, fwd: -20, elbow: 10, wrist: -60, fingers: 12, twist: -20 },
    legL: { flex: 72, knee: 14, ankle: -12, twist: 10 },
    legR: { flex: 76, knee: 26, ankle: -10, twist: 6 },
    contacts: ['sit'],
  };
  const keys: Key[] = [
    { t: 0, p: clone(LIE_BED) },
    { t: 0.7, p: { head: [4, 4, 2], neck: [18, 0, 0], armR: { fingers: 45, elbow: 30 } }, e: 'soft' },
    {
      t: 1.3,
      p: {
        neck: [26, 0, 0],
        head: [4, -10, 0],
        armL: { fwd: -6, down: 30, elbow: 70, twist: -30, wrist: -20 },
        armR: { fwd: -6, down: 30, elbow: 70, twist: -30, wrist: -20 },
        contacts: ['back', 'sit'],
      },
      e: 'soft',
    },
    {
      t: 2.2,
      p: {
        ...sitInBed,
        hips: [-50, 90, 0],
        spine: [18, 0, 0],
        chest: [14, 0, 0],
        neck: [16, 0, 0],
        head: [0, -6, 0],
        legL: { flex: 40, knee: 10, ankle: -14, twist: 12 },
        legR: { flex: 42, knee: 18, ankle: -12, twist: 8 },
        armL: { ...sitInBed.armL, elbow: 40 },
        armR: { ...sitInBed.armR, elbow: 40 },
      },
      e: 'inOut',
    },
    { t: 2.9, p: sitInBed, e: 'out' },
    {
      t: 3.3,
      p: { head: [8, 12, 0], armL: { fwd: 10, down: 44, elbow: 20, wrist: -20 }, armR: { fwd: -30 } },
      e: 'soft',
    },
    {
      t: 4.3,
      p: {
        pos: [0.02, 0, -0.5],
        hips: [-10, 30, 0],
        spine: [10, 0, 0],
        chest: [6, 4, 0],
        head: [8, -6, 0],
        legL: { flex: 78, knee: 70, ankle: -6, twist: 8 },
        legR: { flex: 80, knee: 60, ankle: -6, twist: 8 },
        armL: { ...ARM_REST, fwd: 14, down: 40, elbow: 40, wrist: -30 },
        armR: { ...ARM_REST, fwd: -30, down: 30, elbow: 6, wrist: -60, twist: -20 },
      },
      e: 'inOut',
    },
    { t: 5.0, p: clone(SIT_EDGE), e: 'inOut' },
  ];
  const f = keyed(LIE_BED, keys, { head: 0.12, neck: 0.08, armL: 0.06, armR: 0.1, legR: 0.08 });
  return bake(
    {
      name: 'sit_up_in_bed',
      description:
        'Wakes up in bed, props up on the elbows, sits up and swings the legs over the edge to sit on the bed edge facing +Z (feet at the origin). Starts from lie_asleep, continues into sit_idle.',
      duration: 5.4,
      loop: false,
      next: 'sit_idle',
      setting: 'bed',
    },
    (t) => {
      const p = f(t);
      p.ground = BED_TOP;
      if (!p.contacts) p.contacts = ['sit'];
      // legs only reach the floor at the end: fade IK in
      const w = ramp(t, 4.3, 5.0);
      if (p.legL) p.legL.ikw = w;
      if (p.legR) p.legR.ikw = w;
      if (p.armL) p.armL.ikw = w;
      if (p.armR) p.armR.ikw = w;
      return breathe(p, t, 2.2, 1.2);
    },
  );
}

function sitIdle(): AnimClip {
  const T = 8;
  return bake(
    {
      name: 'sit_idle',
      description:
        'Sitting on the edge of a bed (feet at the origin, bed behind), hands resting on the mattress, breathing, small head movements. Loops.',
      duration: T,
      loop: true,
      setting: 'bed',
    },
    (t) => {
      const p = breathe(clone(SIT_EDGE), t, T / 3, 1.1);
      addTo(p, 'head.1', 8 * loopNoise(t, T, 21, 2));
      addTo(p, 'head.0', 4 * loopNoise(t, T, 22, 2));
      addTo(p, 'chest.1', 2 * loopNoise(t, T, 23, 2));
      return p;
    },
  );
}

function standUp(): AnimClip {
  const stand = clone(STAND);
  const keys: Key[] = [
    { t: 0, p: clone(SIT_EDGE) },
    {
      t: 0.55,
      p: {
        hips: [8, 0, 0],
        spine: [18, 0, 0],
        chest: [10, 0, 0],
        neck: [0, 0, 0],
        head: [0, 0, 0],
        armL: { ik: [0.14, 0.55, 0.02], wrist: -50, fingers: 20 },
        armR: { ik: [-0.14, 0.55, 0.02], wrist: -50, fingers: 20 },
      },
      e: 'inOut',
    },
    {
      t: 1.1,
      p: {
        pos: [0, -0.22, -0.18],
        hips: [30, 0, 0],
        spine: [16, 0, 0],
        chest: [6, 0, 0],
        neck: [-4, 0, 0],
        head: [-6, 0, 0],
        armL: { ik: [0.16, 0.52, 0.08] },
        armR: { ik: [-0.16, 0.52, 0.08] },
        contacts: undefined,
      },
      e: 'inOut',
    },
    {
      t: 1.75,
      p: {
        pos: [0, -0.03, -0.03],
        hips: [6, 0, 0],
        spine: [4, 0, 0],
        chest: [0, 0, 0],
        neck: [6, 0, 0],
        head: [-2, 0, 0],
        armL: { ...ARM_REST, down: 40, fwd: 14, elbow: 26, ikw: 0 },
        armR: { ...ARM_REST, down: 40, fwd: 14, elbow: 26, ikw: 0 },
      },
      e: 'out',
    },
    { t: 2.4, p: stand, e: 'soft' },
  ];
  const f = keyed(SIT_EDGE, keys, { head: 0.1, neck: 0.06, armL: 0.05, armR: 0.08 });
  return bake(
    {
      name: 'stand_up',
      description:
        'Stands up from sitting on a bed edge or chair: leans forward, pushes on the knees, rises and settles, ending standing at the origin. Chain after sit_idle.',
      duration: 2.6,
      loop: false,
      setting: 'bed',
    },
    (t) => {
      const p = f(t);
      const sitW = 1 - ramp(t, 0.55, 1.1);
      if (sitW > 0) {
        p.ground = BED_TOP;
        p.contacts = ['sit'];
        p.groundw = sitW;
      } else {
        delete p.ground;
        delete p.contacts;
      }
      p.legL = {
        ...(p.legL ?? {}),
        ik: [0.12 - 0.02 * ramp(t, 0.8, 1.9), FOOT_Y, -0.02 * (1 - ramp(t, 0.8, 1.9))],
      };
      p.legR = {
        ...(p.legR ?? {}),
        ik: [-0.12 + 0.02 * ramp(t, 0.8, 1.9), FOOT_Y, -0.04 * (1 - ramp(t, 0.8, 1.9))],
      };
      p.legL.ikw = 1;
      p.legR.ikw = 1;
      p.legL.flat = 1;
      p.legR.flat = 1;
      return breathe(p, t, 2, 1);
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Standing actions
// ---------------------------------------------------------------------------------------------

function lookAround(): AnimClip {
  const T = 6.4;
  const yaw = cyclic([
    [0, 0],
    [0.06, 0],
    [0.18, 52],
    [0.34, 55],
    [0.44, 10],
    [0.5, -2],
    [0.6, -58],
    [0.76, -55],
    [0.88, -4],
    [0.95, 0],
  ]);
  const pitch = cyclic([
    [0, 0],
    [0.2, -8],
    [0.34, -14],
    [0.5, 4],
    [0.62, 2],
    [0.78, -6],
    [0.95, 0],
  ]);
  return bake(
    {
      name: 'look_around',
      description:
        'Standing, looks slowly to the left, holds, then to the right, then back to center; head leads, chest and hips follow. Loops (also good as a head/upper-body layer while walking).',
      duration: T,
      loop: true,
    },
    (t) => {
      const p = breathe(clone(STAND), t, T / 3, 1);
      const y = yaw(t / T);
      const yLag = yaw((t - 0.18) / T);
      const pt = pitch((t - 0.05) / T);
      addTo(p, 'head.1', y * 0.55);
      addTo(p, 'neck.1', y * 0.2);
      addTo(p, 'chest.1', yLag * 0.2);
      addTo(p, 'spine.1', yLag * 0.08);
      addTo(p, 'hips.1', yLag * 0.06);
      addTo(p, 'head.0', pt);
      addTo(p, 'neck.0', pt * 0.3);
      addTo(p, 'armL.fwd', -yLag * 0.05);
      addTo(p, 'armR.fwd', yLag * 0.05);
      return p;
    },
  );
}

function scream(): AnimClip {
  const keys: Key[] = [
    { t: 0, p: clone(STAND) },
    {
      t: 0.55,
      p: {
        pos: [0, -0.02, 0],
        spine: [-3, 0, 0],
        chest: [-8, 0, 0],
        neck: [0, 0, 0],
        head: [-6, 0, 0],
        jaw: 6,
        armL: { shrug: 8, down: 40, fwd: -4, elbow: 20, fingers: 40 },
        armR: { shrug: 8, down: 40, fwd: -4, elbow: 20, fingers: 40 },
      },
      e: 'inOut',
    },
    {
      t: 0.85,
      p: {
        pos: [0, -0.04, 0.01],
        hips: [-4, 0, 0],
        spine: [-8, 0, 0],
        chest: [-14, 0, 0],
        neck: [-14, 0, 0],
        head: [-22, 0, 0],
        jaw: 26,
        armL: { shrug: 4, down: 34, fwd: -16, across: -6, elbow: 34, fingers: 88, thumb: 40, wrist: -6 },
        armR: { shrug: 4, down: 34, fwd: -16, across: -6, elbow: 34, fingers: 88, thumb: 40, wrist: -6 },
      },
      e: 'out',
    },
    { t: 2.3, p: { head: [-24, 0, 0], jaw: 24, chest: [-15, 0, 0] }, e: 'linear' },
    {
      t: 2.9,
      p: {
        pos: [0, -0.03, 0],
        hips: [2, 0, 0],
        spine: [8, 0, 0],
        chest: [6, 0, 0],
        neck: [10, 0, 0],
        head: [6, 0, 0],
        jaw: 4,
        armL: { ...ARM_REST, down: 46, elbow: 18, fingers: 30 },
        armR: { ...ARM_REST, down: 46, elbow: 18, fingers: 30 },
      },
      e: 'inOut',
    },
    { t: 3.5, p: clone(STAND), e: 'soft' },
  ];
  const f = keyed(STAND, keys, { head: 0.06, armL: 0.05, armR: 0.07 });
  return bake(
    {
      name: 'scream',
      description:
        'Draws a breath, then screams (a name): head thrown back, chest out, arms pulled back with clenched fists, jaw wide open; holds ~1.4 s, then sags. One-shot.',
      duration: 3.6,
      loop: false,
    },
    (t) => {
      const p = f(t);
      const hold = ramp(t, 0.85, 1.0) * (1 - ramp(t, 2.3, 2.6));
      addTo(p, 'head.0', 1.2 * hold * Math.sin(t * 47));
      addTo(p, 'chest.2', 0.6 * hold * Math.sin(t * 31));
      addTo(p, 'jaw', 1.5 * hold * Math.sin(t * 23));
      return p;
    },
  );
}

function search(): AnimClip {
  const T = 4.8;
  const base = mergePose(STAND, {
    pos: [0, -0.05, 0],
    hips: [10, 0, 0],
    spine: [14, 0, 0],
    chest: [8, 0, 0],
    neck: [14, 0, 0],
    head: [10, 0, 0],
    armL: { ...ARM_REST, ik: [0.12, 0.78, 0.42], ikw: 1, wrist: 10, fingers: 30, ftwist: 20 },
    armR: { ...ARM_REST, ik: [-0.1, 0.78, 0.44], ikw: 1, wrist: 10, fingers: 30, ftwist: 20 },
  });
  return bake(
    {
      name: 'search',
      description:
        'Rummages through an open drawer or counter at waist height in front (~0.45 m ahead, 0.78 m high): leaning in, hands moving and grabbing, glancing up now and then. Loops.',
      duration: T,
      loop: true,
    },
    (t) => {
      const p = breathe(clone(base), t, T / 3, 1);
      const nL = (s: number, a: number) => a * loopNoise(t, T, s, 3);
      const ik = (x: number, s: number): V3 => [
        x + nL(s, 0.09),
        0.78 + nL(s + 1, 0.035),
        0.44 + nL(s + 2, 0.07),
      ];
      p.armL!.ik = ik(0.13, 31);
      p.armR!.ik = ik(-0.11, 41);
      addTo(p, 'armL.fingers', 35 * (0.5 + 0.5 * loopNoise(t, T / 4, 7, 2)));
      addTo(p, 'armR.fingers', 35 * (0.5 + 0.5 * loopNoise(t, T / 4, 8, 2)));
      addTo(p, 'armL.ftwist', 20 * loopNoise(t, T / 2, 17, 2));
      addTo(p, 'armR.ftwist', 20 * loopNoise(t, T / 2, 18, 2));
      const up = bump(t / T, 0.62, 0.08);
      addTo(p, 'head.0', -18 * up);
      addTo(p, 'neck.0', -8 * up);
      addTo(p, 'head.1', 10 * loopNoise(t, T, 51, 2) + 16 * up);
      addTo(p, 'chest.1', 4 * loopNoise(t, T, 52, 2));
      addTo(p, 'pos.0', 0.02 * loopNoise(t, T, 53, 1));
      return p;
    },
  );
}

function pickUp(): AnimClip {
  const crouch: BodyPose = {
    pos: [0.02, -0.46, -0.08],
    hips: [26, -8, 0],
    spine: [22, -6, 0],
    chest: [10, -4, 0],
    neck: [6, 0, 0],
    head: [18, 0, 0],
    armR: { ...ARM_REST, ik: [-0.08, 0.1, 0.42], ikw: 1, wrist: 10, fingers: 10, thumb: 0, ftwist: 30 },
    armL: { ...ARM_REST, ik: [0.2, 0.52, 0.24], ikw: 1, wrist: -30, fingers: 20 },
    legL: legIK(0.12, 0.02, { twist: 12 }),
    legR: legIK(-0.13, 0.14, { twist: 10 }),
  };
  const keys: Key[] = [
    { t: 0, p: clone(STAND) },
    { t: 0.35, p: { head: [18, 0, 0], neck: [12, 0, 0] }, e: 'soft' },
    {
      t: 0.9,
      p: { ...crouch, armR: { ...crouch.armR, fingers: 10 } },
      e: 'inOut',
    },
    { t: 1.2, p: { armR: { fingers: 86, thumb: 45, wrist: 0 } }, e: 'inOut' },
    {
      t: 1.9,
      p: {
        pos: [0, -0.04, 0],
        hips: [4, 0, 0],
        spine: [4, 0, 0],
        chest: [0, 0, 0],
        neck: [8, 0, 0],
        head: [8, 0, 0],
        armR: { ...ARM_REST, ik: [-0.17, 1.02, 0.27], ikw: 1, fingers: 86, thumb: 45, wrist: 0, ftwist: 20 },
        armL: { ...ARM_REST, ikw: 0 },
        legL: legIK(0.1),
        legR: legIK(-0.1),
      },
      e: 'inOut',
    },
    { t: 2.5, p: { pos: [0, -0.01, 0], head: [12, -6, 0], neck: [6, 0, 0] }, e: 'soft' },
  ];
  const f = keyed(STAND, keys, { head: 0.08, armR: 0.04, armL: 0.08 });
  return bake(
    {
      name: 'pick_up',
      description:
        'Crouches, reaches down with the right hand to something on the floor ~0.4 m ahead, grabs it, stands up and looks at it in the hand. Fires event "grab" at 1.2 s. One-shot; continues into hold_item.',
      duration: 2.6,
      loop: false,
      next: 'hold_item',
      events: [{ t: 1.2, name: 'grab' }],
    },
    (t) => breathe(f(t), t, 2.2, 1),
  );
}

const HOLD_ARM_R: ArmPose = {
  ...ARM_REST,
  down: 44,
  fwd: 26,
  twist: 26,
  elbow: 74,
  ftwist: 10,
  wrist: 6,
  wside: 10,
  fingers: 88,
  thumb: 48,
};

function holdItem(): AnimClip {
  const T = 9.6;
  const base = mergePose(STAND, { armR: HOLD_ARM_R, head: [2, -4, 0] });
  return bake(
    {
      name: 'hold_item',
      description:
        "Standing idle holding an item (a knife) in the right hand in front of the body, elbow bent, firm grip. Default layer mask 'arm_r' so it can be layered over walking. Attach the item to the 'hand_r' socket. Loops.",
      duration: T,
      loop: true,
      mask: 'arm_r',
    },
    (t) => {
      const p = idleLife(breathe(clone(base), t, T / 3, 1), t, T, 0.8, 4);
      addTo(p, 'armR.fwd', 1.5 * loopNoise(t, T / 2, 61, 2));
      addTo(p, 'armR.wside', 3 * loopNoise(t, T / 2, 62, 2));
      return p;
    },
  );
}

function crouch(): AnimClip {
  const T = 6;
  const base: BodyPose = {
    pos: [0, -0.5, -0.06],
    hips: [30, 0, 0],
    spine: [16, 0, 0],
    chest: [6, 0, 0],
    neck: [-6, 0, 0],
    head: [-10, 0, 0],
    armL: { ...ARM_REST, ik: [0.19, 0.5, 0.25], ikw: 1, wrist: -20, fingers: 40 },
    armR: { ...ARM_REST, ik: [-0.19, 0.5, 0.25], ikw: 1, wrist: -20, fingers: 40 },
    legL: legIK(0.14, 0.02, { twist: 14, flat: 0.8, ankle: 10 }),
    legR: legIK(-0.14, -0.02, { twist: 14, flat: 0.8, ankle: 10 }),
  };
  return bake(
    {
      name: 'crouch',
      description:
        'Low crouch (hiding / examining something on the floor), forearms near the knees, breathing, watchful. Loops.',
      duration: T,
      loop: true,
    },
    (t) => {
      const p = breathe(clone(base), t, T / 3, 1.2);
      addTo(p, 'head.1', 12 * loopNoise(t, T, 71, 2));
      addTo(p, 'pos.0', 0.015 * loopNoise(t, T, 72, 1));
      return p;
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Faint / floor
// ---------------------------------------------------------------------------------------------

const LIE_FLOOR: BodyPose = {
  pos: [0.05, 0, -0.42],
  hips: [-90, 8, 18],
  spine: [-2, 0, 2],
  chest: [-2, 0, 2],
  neck: [4, -10, 0],
  head: [4, -26, -6],
  jaw: 5,
  armL: { ...ARM_REST, down: 20, fwd: 30, across: 20, elbow: 70, twist: 20, fingers: 35 },
  armR: { ...ARM_REST, down: 0, fwd: 6, elbow: 30, twist: -30, fingers: 30, wrist: 10 },
  legL: { flex: 36, knee: 52, abd: -6, twist: 4, ankle: -20 },
  legR: { flex: 14, knee: 20, abd: 6, twist: 20, ankle: -22 },
  ground: 0,
  contacts: ['back', 'sit', 'side_r', 'head', 'knees', 'feet', 'hands'],
};

function faint(): AnimClip {
  const keys: Key[] = [
    { t: 0, p: clone(STAND) },
    {
      t: 0.8,
      p: {
        pos: [0.03, -0.03, 0],
        hips: [0, 0, 3],
        spine: [6, 0, -2],
        chest: [4, 0, -3],
        neck: [10, 0, 6],
        head: [6, 0, 10],
        armL: { fwd: 60, down: 36, across: 20, elbow: 120, twist: 30, wrist: 10, fingers: 30 },
        legL: legIK(0.1, 0, { twist: 6 }),
      },
      e: 'soft',
    },
    {
      t: 1.6,
      p: {
        pos: [-0.04, -0.07, 0.02],
        hips: [4, -6, -5],
        spine: [10, 0, 4],
        chest: [6, 0, 5],
        neck: [16, 0, -8],
        head: [14, 6, -14],
        armL: { fwd: 30, down: 40, across: 10, elbow: 60 },
        armR: { fwd: 14, down: 30, elbow: 24 },
        legR: legIK(-0.19, 0.06, { twist: 14 }),
      },
      e: 'inOut',
    },
    {
      t: 2.25,
      p: {
        pos: [-0.02, -0.5, -0.06],
        hips: [14, -4, 6],
        spine: [18, 0, 4],
        chest: [14, 0, 2],
        neck: [26, 0, 6],
        head: [16, 0, 10],
        armL: { ...ARM_REST, fwd: 8, down: 42, elbow: 20, fingers: 30 },
        armR: { ...ARM_REST, fwd: 6, down: 38, elbow: 16, fingers: 30 },
        legL: { flex: 80, knee: 120, ik: undefined, ikw: 0, ankle: -30, twist: 6 },
        legR: { flex: 70, knee: 118, ik: undefined, ikw: 0, ankle: -30, twist: 14 },
        contacts: ['feet', 'knees'],
      },
      e: 'in',
    },
    {
      t: 2.8,
      p: {
        pos: [0, -0.7, -0.25],
        hips: [-40, 4, 14],
        spine: [10, 0, 4],
        chest: [6, 0, 4],
        neck: [20, -4, 4],
        head: [10, -10, 4],
        armL: { fwd: 26, down: 30, across: 12, elbow: 50 },
        armR: { fwd: 6, down: 14, elbow: 26 },
        legL: { flex: 60, knee: 90, ankle: -26 },
        legR: { flex: 40, knee: 70, ankle: -26, abd: 6 },
        contacts: ['feet', 'knees', 'sit', 'back', 'side_r', 'hands'],
      },
      e: 'in',
    },
    { t: 3.2, p: clone(LIE_FLOOR), e: 'in' },
    { t: 3.45, p: { neck: [8, -8, 0], head: [8, -22, -4], armL: { elbow: 76 } }, e: 'out' },
    { t: 3.9, p: clone(LIE_FLOOR), e: 'soft' },
  ];
  const f = keyed(STAND, keys, { head: 0.1, neck: 0.06, armL: 0.08, armR: 0.12 });
  return bake(
    {
      name: 'faint',
      description:
        'Gets dizzy (hand to the head, sways, staggers), knees buckle, drops to the knees and collapses backward onto the floor, ending lying on his back ~0.4 m behind the origin. One-shot; continues into lie_floor.',
      duration: 4.0,
      loop: false,
      next: 'lie_floor',
      setting: 'floor',
    },
    (t) => {
      const p = f(t);
      const collapse = ramp(t, 1.7, 2.25);
      if (collapse <= 0) {
        delete p.ground;
      } else {
        p.ground = 0;
        if (!p.contacts) p.contacts = ['feet', 'knees'];
        p.groundw = collapse;
        if (p.legL) p.legL.ikw = Math.max(0, 1 - collapse * 2);
        if (p.legR) p.legR.ikw = Math.max(0, 1 - collapse * 2);
      }
      const sway = ramp(t, 0.3, 0.9) * (1 - collapse);
      addTo(p, 'pos.0', 0.03 * sway * Math.sin(t * 3.4));
      addTo(p, 'hips.2', 3 * sway * Math.sin(t * 3.4 + 0.4));
      addTo(p, 'head.2', 5 * sway * Math.sin(t * 3.4 + 1));
      return p;
    },
  );
}

function lieFloor(): AnimClip {
  const T = 8;
  return bake(
    {
      name: 'lie_floor',
      description:
        'Lying unconscious on the floor on his back, slightly turned to his right, shallow breathing. Head toward -Z, hips ~0.4 m behind the origin (the end of faint). Loops.',
      duration: T,
      loop: true,
      setting: 'floor',
    },
    (t) => breathe(clone(LIE_FLOOR), t, T / 2, 0.8),
  );
}

function wakeUpFloor(): AnimClip {
  const sitFloor: BodyPose = {
    pos: [0.02, 0, -0.38],
    hips: [-24, 0, 0],
    spine: [18, 0, 0],
    chest: [12, 0, 0],
    neck: [10, 0, 0],
    head: [10, 0, 0],
    armL: { ...ARM_REST, down: 34, fwd: -30, elbow: 10, wrist: -60, twist: -20, fingers: 20 },
    armR: { ...ARM_REST, down: 34, fwd: -30, elbow: 10, wrist: -60, twist: -20, fingers: 20 },
    legL: { flex: 60, knee: 100, ankle: 8, twist: 10, abd: 4 },
    legR: { flex: 40, knee: 60, ankle: -10, twist: 20, abd: 8 },
    ground: 0,
    contacts: ['sit', 'feet', 'hands'],
  };
  const rubHead: BodyPose = {
    head: [22, 8, 0],
    neck: [16, 0, 0],
    spine: [22, 0, 0],
    armR: { ...ARM_REST, down: 20, fwd: 100, across: -30, twist: -40, elbow: 150, wrist: 20, fingers: 30 },
    armL: { ...ARM_REST, down: 30, fwd: 40, elbow: 50, wrist: -10, fingers: 20 },
  };
  const kneel: BodyPose = {
    pos: [0, -0.42, -0.2],
    hips: [8, 10, 0],
    spine: [16, 0, 0],
    chest: [8, 0, 0],
    neck: [4, 0, 0],
    head: [2, -6, 0],
    armL: { ...ARM_REST, ik: [0.16, 0.56, 0.12], ikw: 1, wrist: -40, fingers: 20 },
    armR: { ...ARM_REST, down: 40, fwd: 10, elbow: 30, fingers: 30, ikw: 0 },
    legL: legIK(0.14, 0.12, { twist: 8 }),
    legR: { flex: 4, knee: 96, ankle: -24, twist: 8, ikw: 0 },
    contacts: ['feet', 'knees'],
    ground: 0,
  };
  const keys: Key[] = [
    { t: 0, p: clone(LIE_FLOOR) },
    {
      t: 0.9,
      p: { head: [2, -10, -4], neck: [10, 0, 0], armL: { fingers: 60 }, armR: { fingers: 55 } },
      e: 'soft',
    },
    {
      t: 1.6,
      p: {
        hips: [-80, 20, 30],
        neck: [18, 10, 0],
        head: [6, 0, 0],
        armL: { fwd: 50, down: 20, across: 40, elbow: 80, twist: 10 },
        armR: { down: 20, fwd: -10, elbow: 90, twist: -40 },
        legL: { flex: 50, knee: 80 },
      },
      e: 'inOut',
    },
    {
      t: 2.6,
      p: {
        ...sitFloor,
        hips: [-45, 10, 12],
        spine: [20, 0, 4],
        armR: { ...ARM_REST, down: 30, fwd: -40, elbow: 20, wrist: -60, twist: -30 },
      },
      e: 'inOut',
    },
    { t: 3.2, p: clone(sitFloor), e: 'out' },
    { t: 3.7, p: rubHead, e: 'inOut' },
    {
      t: 4.9,
      p: { ...rubHead, head: [16, -8, 0], armR: { ...rubHead.armR!, fwd: 96, elbow: 146 } },
      e: 'linear',
    },
    {
      t: 5.5,
      p: {
        ...sitFloor,
        pos: [0.02, 0, -0.34],
        hips: [-10, 10, 0],
        legR: { flex: 20, knee: 110, ankle: -20, twist: 8, abd: 0 },
        legL: { flex: 70, knee: 110, ankle: 10, twist: 8 },
      },
      e: 'inOut',
    },
    { t: 6.3, p: kneel, e: 'inOut' },
    {
      t: 7.1,
      p: {
        pos: [0, -0.12, -0.08],
        hips: [18, 4, 0],
        spine: [10, 0, 0],
        chest: [4, 0, 0],
        armL: { ik: [0.16, 0.62, 0.14] },
        legR: legIK(-0.12, -0.02, { twist: 8 }),
        contacts: ['feet'],
      },
      e: 'inOut',
    },
    { t: 7.9, p: { ...clone(STAND), armL: { ...ARM_REST, ikw: 0 } }, e: 'out' },
  ];
  const f = keyed(LIE_FLOOR, keys, { head: 0.1, neck: 0.06, armR: 0.08, armL: 0.06 });
  return bake(
    {
      name: 'wake_up_floor',
      description:
        'Comes to on the floor (from lie_floor): stirs, rolls and pushes up to sitting, rubs the back of his head, gets onto one knee and stands up, ending standing at the origin. One-shot.',
      duration: 8.2,
      loop: false,
      setting: 'floor',
    },
    (t) => {
      const p = f(t);
      const standW = ramp(t, 6.8, 7.6);
      p.ground = 0;
      p.groundw = 1 - standW;
      if (!p.contacts) p.contacts = ['back', 'sit'];
      if (t > 6.2 && p.legL) p.legL.ikw = 1;
      if (t > 6.8 && p.legR) p.legR.ikw = ramp(t, 6.8, 7.2);
      if (t < 6.0 && p.armL) p.armL.ikw = ramp(t, 5.5, 6.0);
      if (t > 7.4 && p.armL) p.armL.ikw = 1 - ramp(t, 7.4, 7.9);
      return breathe(p, t, 1.8, 1.3);
    },
  );
}

function cough(): AnimClip {
  const fistToMouth: ArmPose = {
    ...ARM_REST,
    ik: [0.03, 1.5, 0.2],
    ikw: 1,
    wrist: 30,
    fingers: 80,
    thumb: 40,
    ftwist: 60,
  };
  const keys: Key[] = [
    { t: 0, p: clone(STAND) },
    { t: 0.45, p: { armL: fistToMouth, head: [6, 0, 0], chest: [2, 0, 0] }, e: 'inOut' },
    { t: 1.75, p: { armL: fistToMouth }, e: 'linear' },
    { t: 2.3, p: { armL: { ...ARM_REST, ikw: 0 } }, e: 'inOut' },
  ];
  const f = keyed(STAND, keys, { armL: 0.03 });
  const coughs = [0.6, 1.0, 1.42];
  return bake(
    {
      name: 'cough',
      description: 'Raises a fist to the mouth and coughs three times, hunching with each cough. One-shot.',
      duration: 2.4,
      loop: false,
    },
    (t) => {
      const p = f(t);
      let k = 0;
      for (const c of coughs) k += bump(t, c + 0.06, 0.13) * (c === coughs[0] ? 1 : 0.85);
      const pre = coughs.reduce((a, c) => a + bump(t, c - 0.08, 0.08), 0);
      addTo(p, 'spine.0', 9 * k - 2 * pre);
      addTo(p, 'chest.0', 7 * k - 3 * pre);
      addTo(p, 'neck.0', 5 * k);
      addTo(p, 'head.0', 6 * k);
      addTo(p, 'jaw', 10 * k + 4 * pre);
      addTo(p, 'armL.shrug', 4 * k);
      addTo(p, 'armR.shrug', 4 * k);
      addTo(p, 'pos.1', -0.015 * k);
      addTo(p, 'armR.elbow', 10 * k);
      return p;
    },
  );
}

function hideItem(): AnimClip {
  const tuck: ArmPose = {
    ...HOLD_ARM_R,
    ik: [-0.13, 0.94, -0.13],
    ikw: 1,
    fingers: 70,
    wrist: -20,
    ftwist: -30,
  };
  const keys: Key[] = [
    { t: 0, p: mergePose(STAND, { armR: HOLD_ARM_R }) },
    { t: 0.5, p: { head: [22, -24, 0], neck: [8, -8, 0], chest: [4, -8, 0] }, e: 'soft' },
    { t: 1.1, p: { armR: tuck, chest: [4, -12, 2], spine: [4, -6, 0] }, e: 'inOut' },
    { t: 1.35, p: { armR: { ...tuck, ik: [-0.12, 0.9, -0.14], fingers: 20, thumb: 10 } }, e: 'inOut' },
    {
      t: 1.8,
      p: {
        armR: { ...tuck, ik: [-0.17, 0.9, -0.08], fingers: 20, wrist: 0 },
        armL: { ik: [0.06, 0.92, 0.17], ikw: 1, fingers: 20, wrist: -10 },
        head: [26, 0, 0],
        chest: [4, 0, 0],
      },
      e: 'inOut',
    },
    {
      t: 2.5,
      p: { ...clone(STAND), head: [0, 16, 0], armL: { ...ARM_REST, ikw: 0 }, armR: { ...ARM_REST, ikw: 0 } },
      e: 'inOut',
    },
    { t: 3.1, p: { head: [-4, 0, 0] }, e: 'soft' },
  ];
  const f = keyed(mergePose(STAND, { armR: HOLD_ARM_R }), keys, { head: 0.08, armL: 0.05 });
  return bake(
    {
      name: 'hide_item',
      description:
        "Hides the held item: looks down, tucks it into the back of the belt on the right hip, tugs the hoodie over it and glances around. Fires event 'tuck' at 1.3 s (switch the item's Attachment socket from 'hand_r' to 'belt_r' then). One-shot.",
      duration: 3.2,
      loop: false,
      events: [{ t: 1.3, name: 'tuck' }],
    },
    (t) => breathe(f(t), t, 2.2, 1),
  );
}

function breatheHeavy(): AnimClip {
  const T = 2.6;
  const base: BodyPose = {
    ...clone(STAND),
    pos: [0, -0.1, -0.03],
    hips: [22, 0, 0],
    spine: [16, 0, 0],
    chest: [8, 0, 0],
    neck: [4, 0, 0],
    head: [8, 0, 0],
    jaw: 6,
    armL: { ...ARM_REST, ik: [0.16, 0.66, 0.2], ikw: 1, wrist: -30, fingers: 30 },
    armR: { ...ARM_REST, ik: [-0.16, 0.66, 0.2], ikw: 1, wrist: -30, fingers: 30 },
    legL: legIK(0.13, 0, { twist: 8 }),
    legR: legIK(-0.13, 0, { twist: 8 }),
  };
  return bake(
    {
      name: 'breathe_heavy',
      description:
        'Exhausted: bent forward with hands on the thighs, big heaving breaths, mouth open. Loops.',
      duration: T,
      loop: true,
    },
    (t) => {
      const p = breathe(clone(base), t, T / 2, 3.2);
      const b = Math.sin((2 * Math.PI * t) / (T / 2));
      addTo(p, 'jaw', 5 * Math.max(0, b));
      addTo(p, 'pos.1', 0.006 * b);
      return p;
    },
  );
}

function scaredBreathing(): AnimClip {
  const T = 4.8;
  const base = mergePose(STAND, {
    pos: [0, -0.035, -0.01],
    spine: [3, 0, 0],
    chest: [-2, 0, 0],
    neck: [2, 0, 0],
    head: [0, 0, 0],
    jaw: 4,
    armL: {
      shrug: 9,
      reach: 5,
      down: 50,
      fwd: 28,
      across: 18,
      elbow: 96,
      twist: 20,
      wrist: 20,
      fingers: 50,
      thumb: 30,
    },
    armR: {
      shrug: 9,
      reach: 5,
      down: 48,
      fwd: 18,
      across: 8,
      elbow: 70,
      twist: 12,
      wrist: 10,
      fingers: 60,
      thumb: 30,
    },
  });
  const jerk = cyclic([
    [0, 0],
    [0.2, 0],
    [0.24, 22],
    [0.45, 20],
    [0.5, 0],
    [0.68, -2],
    [0.72, -26],
    [0.9, -22],
    [0.95, 0],
  ]);
  return bake(
    {
      name: 'scared_breathing',
      description:
        'Frightened: upright and tense, hands drawn up near the chest, rapid shallow breathing, sudden head turns toward noises. Loops.',
      duration: T,
      loop: true,
    },
    (t) => {
      const p = breathe(clone(base), t, T / 6, 1.8);
      const j = jerk(t / T);
      addTo(p, 'head.1', j * 0.7);
      addTo(p, 'neck.1', j * 0.2);
      addTo(p, 'chest.1', jerk((t - 0.1) / T) * 0.12);
      addTo(p, 'armL.fingers', 10 * loopNoise(t, T / 2, 81, 2));
      addTo(p, 'pos.0', 0.008 * loopNoise(t, T, 82, 2));
      return p;
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

const BUILDERS: Record<string, () => AnimClip> = {
  idle,
  idle_nervous: idleNervous,
  walk,
  run,
  lie_asleep: lieAsleep,
  sit_up_in_bed: sitUpInBed,
  sit_idle: sitIdle,
  stand_up: standUp,
  look_around: lookAround,
  scream,
  search,
  pick_up: pickUp,
  hold_item: holdItem,
  crouch,
  faint,
  lie_floor: lieFloor,
  wake_up_floor: wakeUpFloor,
  cough,
  hide_item: hideItem,
  breathe_heavy: breatheHeavy,
  scared_breathing: scaredBreathing,
};

/** Alternative names accepted everywhere a built-in clip name is (story-script vocabulary). */
export const CLIP_ALIASES: Record<string, string> = {
  lie_sleep: 'lie_asleep',
  sleep: 'lie_asleep',
  sit_up_bed: 'sit_up_in_bed',
  sit_up: 'sit_up_in_bed',
  sit: 'sit_idle',
  search_drawer: 'search',
  faint_collapse: 'faint',
  collapse: 'faint',
  lie_unconscious: 'lie_floor',
  wake_on_floor_rub_back: 'wake_up_floor',
  wake_up: 'wake_up_floor',
  hide_in_belt: 'hide_item',
  hold: 'hold_item',
  hold_knife: 'hold_item',
  panting: 'breathe_heavy',
  nervous: 'idle_nervous',
};

const cache = new Map<string, AnimClip>();

/** Names of all built-in clips (without aliases). */
export function builtinClipNames(): string[] {
  return Object.keys(BUILDERS);
}

/** Resolves a built-in clip name or alias to its canonical name (null when unknown). */
export function canonicalClipName(name: string): string | null {
  if (BUILDERS[name]) return name;
  const a = CLIP_ALIASES[name];
  return a && BUILDERS[a] ? a : null;
}

/** A built-in clip by name or alias (generated on first use and cached), or null. */
export function builtinClip(name: string): AnimClip | null {
  const canon = canonicalClipName(name);
  if (!canon) return null;
  let c = cache.get(canon);
  if (!c) {
    c = BUILDERS[canon]!();
    cache.set(canon, c);
  }
  return c;
}
