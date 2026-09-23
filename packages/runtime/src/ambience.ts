// Procedural atmosphere audio: looping ambiences (wind, storm, rain on a window, fridge hum...) and
// the story one-shots (thunder, creaks, doors, footsteps, gasps...). Everything here is isomorphic:
// it renders raw mono samples deterministically from a seed, so it is unit-testable in Node and
// the Web Audio backend just wraps the results in AudioBuffers.
import { Rng } from './math.ts';

export const AMBIENCE_KINDS = [
  'wind',
  'storm',
  'rain',
  'rain_window',
  'fridge_hum',
  'fire',
  'creaks',
  'birds',
  'crickets',
  'room_tone',
  'heartbeat',
  'breathing',
] as const;
export type AmbienceKind = (typeof AMBIENCE_KINDS)[number];

export function isAmbienceKind(v: unknown): v is AmbienceKind {
  return typeof v === 'string' && (AMBIENCE_KINDS as readonly string[]).includes(v);
}

/** One-shot presets for story games (in addition to the arcade presets). */
export const STORY_SFX = [
  'thunder',
  'thunder_distant',
  'creak',
  'door_creak',
  'door_open',
  'door_close',
  'door_locked',
  'footstep_wood',
  'gasp',
  'cough',
  'knife_pickup',
  'drawer',
  'glass_clink',
  'whoosh',
  'heartbeat_single',
  'thud_body',
  'breath_in',
  'breath_out',
  'bird_call',
] as const;
export type StorySfx = (typeof STORY_SFX)[number];

export function isStorySfx(v: unknown): v is StorySfx {
  return typeof v === 'string' && (STORY_SFX as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------------------------
// DSP building blocks
// ---------------------------------------------------------------------------------------------

const TAU = Math.PI * 2;

/** Topology-preserving state-variable filter (stable under fast cutoff modulation). */
class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1;
  low = 0;
  band = 0;
  high = 0;
  private readonly sr: number;
  constructor(sr: number, freq = 1000, q = Math.SQRT1_2) {
    this.sr = sr;
    this.set(freq, q);
  }
  set(freq: number, q: number): void {
    const f = Math.max(10, Math.min(this.sr * 0.45, freq));
    const g = Math.tan((Math.PI * f) / this.sr);
    this.k = 1 / Math.max(0.05, q);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  process(x: number): void {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = v1;
    this.high = x - this.k * v1 - v2;
  }
}

/** Pink noise (Paul Kellet's refined filter). */
class Pink {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;
  private b5 = 0;
  private b6 = 0;
  next(w: number): number {
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.969 * this.b2 + w * 0.153852;
    this.b3 = 0.8665 * this.b3 + w * 0.3104856;
    this.b4 = 0.55 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.016898;
    const out = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
    this.b6 = w * 0.115926;
    return out * 0.11;
  }
}

/** Brown (red) noise. */
class Brown {
  private last = 0;
  next(w: number): number {
    this.last = (this.last + 0.02 * w) / 1.02;
    return this.last * 3.5;
  }
}

/** Smooth random curve in 0..1: cosine-interpolated random points every `period` seconds. */
function smoothCurve(rng: Rng, seconds: number, period: number, shape = 1): (t: number) => number {
  const n = Math.ceil(seconds / period) + 3;
  const pts = Array.from({ length: n }, () => rng.next() ** shape);
  return (t: number) => {
    const x = Math.max(0, t / period);
    const i = Math.floor(x);
    const f = x - i;
    const a = pts[i % n]!;
    const b = pts[(i + 1) % n]!;
    const m = (1 - Math.cos(f * Math.PI)) / 2;
    return a + (b - a) * m;
  };
}

function normalize(buf: Float32Array, peak: number): Float32Array {
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]!));
  if (max > 1e-9) {
    const k = peak / max;
    for (let i = 0; i < buf.length; i++) buf[i]! *= k;
  }
  return buf;
}

function normalizeRms(buf: Float32Array, rms: number, maxPeak = 0.95): Float32Array {
  let sum = 0;
  let max = 0;
  for (let i = 0; i < buf.length; i++) {
    sum += buf[i]! * buf[i]!;
    max = Math.max(max, Math.abs(buf[i]!));
  }
  const cur = Math.sqrt(sum / Math.max(1, buf.length));
  if (cur < 1e-9) return buf;
  const k = Math.min(rms / cur, maxPeak / Math.max(1e-9, max));
  for (let i = 0; i < buf.length; i++) buf[i]! *= k;
  return buf;
}

/** Adds a decaying sine "ping" (droplets, clicks, metal partials) into `out`. */
function ping(out: Float32Array, sr: number, at: number, freq: number, decay: number, amp: number): void {
  const start = Math.floor(at * sr);
  const len = Math.min(out.length - start, Math.ceil(decay * 7 * sr));
  if (start < 0 || len <= 0) return;
  const w = (TAU * freq) / sr;
  const d = Math.exp(-1 / (decay * sr));
  let env = amp;
  for (let i = 0; i < len; i++) {
    out[start + i]! += Math.sin(w * i) * env;
    env *= d;
  }
}

/** Adds a band-passed noise burst into `out`. */
function burst(
  out: Float32Array,
  sr: number,
  rng: Rng,
  at: number,
  opts: {
    freq: number;
    q: number;
    attack: number;
    decay: number;
    amp: number;
    mode?: 'band' | 'low' | 'high';
  },
): void {
  const start = Math.floor(at * sr);
  const len = Math.min(out.length - start, Math.ceil((opts.attack + opts.decay * 6) * sr));
  if (start < 0 || len <= 0) return;
  const f = new Svf(sr, opts.freq, opts.q);
  const att = Math.max(1, opts.attack * sr);
  const d = Math.exp(-1 / (Math.max(1e-4, opts.decay) * sr));
  let env = 1;
  for (let i = 0; i < len; i++) {
    f.process(rng.next() * 2 - 1);
    const y = opts.mode === 'low' ? f.low : opts.mode === 'high' ? f.high : f.band;
    const a = i < att ? i / att : (env *= d);
    out[start + i]! += y * a * opts.amp;
  }
}

/** A sine whose frequency glides exponentially from f0 to f1 (thumps, heartbeats). */
function glideSine(
  out: Float32Array,
  sr: number,
  at: number,
  f0: number,
  f1: number,
  attack: number,
  decay: number,
  amp: number,
): void {
  const start = Math.floor(at * sr);
  const len = Math.min(out.length - start, Math.ceil((attack + decay * 6) * sr));
  if (start < 0 || len <= 0) return;
  let phase = 0;
  const att = Math.max(1, attack * sr);
  const d = Math.exp(-1 / (decay * sr));
  let env = 1;
  for (let i = 0; i < len; i++) {
    const k = i / len;
    const f = f0 * (f1 / f0) ** k;
    phase += (TAU * f) / sr;
    const a = i < att ? i / att : (env *= d);
    out[start + i]! += Math.sin(phase) * a * amp;
  }
}

// ---------------------------------------------------------------------------------------------
// Ambience loops
// ---------------------------------------------------------------------------------------------

/** Loud but safe loudness per ambience; AudioSource.volume scales it. */
const LOOP_RMS: Partial<Record<AmbienceKind, number>> = {
  wind: 0.16,
  storm: 0.2,
  rain: 0.1,
  rain_window: 0.1,
  fridge_hum: 0.07,
  fire: 0.12,
  creaks: 0.012,
  birds: 0.02,
  crickets: 0.05,
  room_tone: 0.025,
};

/** Kinds that are pure event schedulers (no loop buffer). */
export const EVENT_ONLY_AMBIENCE: readonly AmbienceKind[] = ['heartbeat', 'breathing'];

/**
 * Renders a seamless loop for an ambience kind (mono, -1..1). Loops are `seconds` long (tonal
 * components use frequencies that fit the loop exactly; noise is crossfaded). Returns an empty
 * array for event-only kinds (heartbeat, breathing), which the backend schedules beat by beat.
 */
export function renderAmbienceLoop(
  kind: AmbienceKind,
  sampleRate = 44100,
  seed = 7,
  seconds = 10,
): Float32Array {
  if (EVENT_ONLY_AMBIENCE.includes(kind)) return new Float32Array(0);
  const sr = sampleRate;
  const n = Math.round(seconds * sr);
  const xf = Math.round(Math.min(1.5, seconds / 4) * sr);
  const total = n + xf;
  const rng = new Rng(seed * 7919 + kind.length * 131 + kind.charCodeAt(0));
  const raw = new Float32Array(total);
  const secs = total / sr;
  switch (kind) {
    case 'wind':
      renderWind(raw, sr, rng, secs, 1);
      break;
    case 'storm': {
      renderWind(raw, sr, rng, secs, 1.25);
      const rain = new Float32Array(total);
      renderRain(rain, sr, rng, secs, false);
      const rumble = new Brown();
      const lp = new Svf(sr, 90, 0.7);
      const swell = smoothCurve(rng, secs, 3.2, 1.5);
      for (let i = 0; i < total; i++) {
        lp.process(rumble.next(rng.next() * 2 - 1));
        raw[i]! += rain[i]! * 0.9 + lp.low * (0.6 + 1.4 * swell(i / sr));
      }
      break;
    }
    case 'rain':
      renderRain(raw, sr, rng, secs, false);
      break;
    case 'rain_window':
      renderRain(raw, sr, rng, secs, true);
      break;
    case 'fridge_hum':
      renderFridge(raw, sr, rng, seconds);
      break;
    case 'fire':
      renderFire(raw, sr, rng, secs);
      break;
    case 'crickets':
      renderCrickets(raw, sr, rng, seconds);
      break;
    case 'birds': {
      // soft morning air; the chirps themselves are scheduled live (never repeating)
      const pink = new Pink();
      const lp = new Svf(sr, 2600, 0.6);
      const leaves = new Svf(sr, 3800, 1.4);
      const rustle = smoothCurve(rng, secs, 2.5, 2);
      for (let i = 0; i < total; i++) {
        const w = rng.next() * 2 - 1;
        lp.process(pink.next(w));
        leaves.process(w);
        raw[i] = lp.low * 0.6 + leaves.band * 0.25 * rustle(i / sr);
      }
      break;
    }
    case 'creaks':
    case 'room_tone': {
      const brown = new Brown();
      const pink = new Pink();
      const lp = new Svf(sr, 260, 0.7);
      const lp2 = new Svf(sr, 2800, 0.7);
      for (let i = 0; i < total; i++) {
        const w = rng.next() * 2 - 1;
        lp.process(brown.next(w));
        lp2.process(pink.next(rng.next() * 2 - 1));
        raw[i] = lp.low * 0.8 + lp2.low * 0.12 + Math.sin((TAU * 60 * i) / sr) * 0.03;
      }
      break;
    }
    default:
      break;
  }
  // Seamless loop: fold the tail over the head. Tonal kinds use a linear crossfade (identical
  // phase), noisy ones an equal-power one.
  const tonal = kind === 'fridge_hum' || kind === 'crickets';
  const out = new Float32Array(n);
  out.set(raw.subarray(0, n));
  for (let i = 0; i < xf; i++) {
    const a = i / xf;
    const fi = tonal ? a : Math.sqrt(a);
    const fo = tonal ? 1 - a : Math.sqrt(1 - a);
    out[i] = raw[i]! * fi + raw[n + i]! * fo;
  }
  return normalizeRms(out, LOOP_RMS[kind] ?? 0.08);
}

function renderWind(out: Float32Array, sr: number, rng: Rng, secs: number, strength: number): void {
  const pink = new Pink();
  const body = new Svf(sr, 500, 0.6);
  const howl1 = new Svf(sr, 320, 6);
  const howl2 = new Svf(sr, 700, 9);
  const whistle = new Svf(sr, 1400, 14);
  const gust = smoothCurve(rng, secs, 2.4, 1.6);
  const g2 = smoothCurve(rng, secs, 3.7, 1.2);
  const g3 = smoothCurve(rng, secs, 1.6, 2);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const g = Math.min(1, gust(t) * strength);
    if ((i & 31) === 0) {
      body.set(300 + 1100 * g, 0.6);
      howl1.set(240 + 460 * g2(t), 6);
      howl2.set(560 + 620 * g, 9);
      whistle.set(1100 + 900 * g3(t), 14);
    }
    const w = rng.next() * 2 - 1;
    const p = pink.next(w);
    body.process(p);
    howl1.process(p);
    howl2.process(p);
    whistle.process(w * 0.3);
    out[i] =
      body.low * (0.25 + 0.75 * g) +
      howl1.band * 1.2 * g ** 1.4 +
      howl2.band * 0.7 * (g * g2(t)) ** 1.5 +
      whistle.band * 0.25 * g3(t) ** 3 * g;
  }
}

function renderRain(out: Float32Array, sr: number, rng: Rng, secs: number, window: boolean): void {
  const hp = new Svf(sr, window ? 400 : 700, 0.7);
  const lp = new Svf(sr, window ? 2600 : 7500, 0.7);
  const drift = smoothCurve(rng, secs, 4, 1);
  for (let i = 0; i < out.length; i++) {
    hp.process(rng.next() * 2 - 1);
    lp.process(hp.high);
    out[i] = lp.low * (window ? 0.18 : 0.35) * (0.75 + 0.25 * drift(i / sr));
  }
  // droplets
  const rate = window ? 45 : 240;
  let t = 0;
  while (t < secs) {
    t += -Math.log(1 - rng.next()) / rate;
    const r = rng.next();
    if (window) ping(out, sr, t, 2400 + 3800 * rng.next(), 0.0015 + 0.0025 * rng.next(), 0.05 + 0.35 * r * r);
    else ping(out, sr, t, 1500 + 3500 * rng.next(), 0.002 + 0.005 * rng.next(), 0.03 + 0.12 * r * r);
  }
  if (window) {
    // water running down the glass + wind gusts thumping the pane
    const stream = new Svf(sr, 1800, 1.5);
    const flow = smoothCurve(rng, secs, 1.3, 2);
    for (let i = 0; i < out.length; i++) {
      stream.process(rng.next() * 2 - 1);
      out[i]! += stream.band * 0.08 * flow(i / sr);
    }
    let g = 1 + rng.next() * 2;
    while (g < secs - 1) {
      burst(out, sr, rng, g, { freq: 90, q: 0.8, attack: 0.15, decay: 0.25, amp: 0.5, mode: 'low' });
      g += 2.5 + rng.next() * 4;
    }
  }
}

function renderFridge(out: Float32Array, sr: number, rng: Rng, loopSeconds: number): void {
  // Frequencies are multiples of 1/loopSeconds so every partial repeats exactly at the loop point.
  const q = (f: number) => Math.round(f * loopSeconds) / loopSeconds;
  const partials: [number, number][] = [
    [q(60), 0.5],
    [q(120.4), 0.36],
    [q(180), 0.16],
    [q(240.2), 0.09],
    [q(300.7), 0.05],
    [q(1130), 0.006],
  ];
  const wob = q(0.2);
  const brown = new Brown();
  const lp = new Svf(sr, 160, 0.8);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let s = 0;
    for (const [f, a] of partials) s += Math.sin(TAU * f * t) * a;
    lp.process(brown.next(rng.next() * 2 - 1));
    out[i] = s * (0.88 + 0.12 * Math.sin(TAU * wob * t)) + lp.low * 0.12;
  }
}

function renderFire(out: Float32Array, sr: number, rng: Rng, secs: number): void {
  const brown = new Brown();
  const lp = new Svf(sr, 480, 0.7);
  const hiss = new Svf(sr, 3500, 0.7);
  const flick = smoothCurve(rng, secs, 0.7, 1);
  for (let i = 0; i < out.length; i++) {
    const w = rng.next() * 2 - 1;
    lp.process(brown.next(w));
    hiss.process(w);
    out[i] = lp.low * 0.55 * (0.6 + 0.4 * flick(i / sr)) + hiss.high * 0.025;
  }
  let t = 0;
  while (t < secs) {
    t += -Math.log(1 - rng.next()) / 7;
    const n = 1 + Math.floor(rng.next() * 5);
    let c = t;
    for (let k = 0; k < n; k++) {
      burst(out, sr, rng, c, {
        freq: 1400 + 2800 * rng.next(),
        q: 1.5,
        attack: 0.0005,
        decay: 0.002 + 0.008 * rng.next(),
        amp: 0.3 + 0.9 * rng.next() ** 2,
      });
      c += 0.003 + 0.015 * rng.next();
    }
    if (rng.next() < 0.12) glideSine(out, sr, t, 180, 90, 0.002, 0.03, 0.25);
  }
}

function renderCrickets(out: Float32Array, sr: number, rng: Rng, loopSeconds: number): void {
  const crickets = [
    { carrier: 4400, period: loopSeconds / 16, pulses: 3, amp: 0.32, offset: 0.1 },
    { carrier: 4850, period: loopSeconds / 12, pulses: 4, amp: 0.2, offset: 0.37 },
    { carrier: 5200, period: loopSeconds / 10, pulses: 3, amp: 0.12, offset: 0.61 },
  ];
  for (const c of crickets) {
    const w = (TAU * Math.round(c.carrier * loopSeconds)) / loopSeconds / sr;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const ph = (t + c.offset * c.period) % c.period;
      const pulseLen = 0.018;
      const gap = 0.022;
      const k = Math.floor(ph / (pulseLen + gap));
      if (k >= c.pulses) continue;
      const pt = ph - k * (pulseLen + gap);
      if (pt > pulseLen) continue;
      const env = Math.sin((Math.PI * pt) / pulseLen) ** 2;
      out[i]! += Math.sin(w * i) * env * c.amp;
    }
  }
  const pink = new Pink();
  const lp = new Svf(sr, 1500, 0.7);
  for (let i = 0; i < out.length; i++) {
    lp.process(pink.next(rng.next() * 2 - 1));
    out[i]! += lp.low * 0.04;
  }
}

// ---------------------------------------------------------------------------------------------
// Story one-shots
// ---------------------------------------------------------------------------------------------

/** Relative loudness of each story preset (peak after normalization). */
const STORY_PEAK: Record<StorySfx, number> = {
  thunder: 0.95,
  thunder_distant: 0.55,
  creak: 0.5,
  door_creak: 0.55,
  door_open: 0.6,
  door_close: 0.8,
  door_locked: 0.65,
  footstep_wood: 0.5,
  gasp: 0.6,
  cough: 0.6,
  knife_pickup: 0.5,
  drawer: 0.55,
  glass_clink: 0.45,
  whoosh: 0.5,
  heartbeat_single: 0.85,
  thud_body: 0.9,
  breath_in: 0.35,
  breath_out: 0.32,
  bird_call: 0.35,
};

/** Synthesizes a story one-shot (mono, -1..1). `seed` gives variations (footsteps, creaks). */
export function synthStorySfx(preset: StorySfx, sampleRate = 44100, seed = 1): Float32Array {
  const sr = sampleRate;
  const rng = new Rng(seed * 104729 + preset.length * 7 + preset.charCodeAt(0) * 31);
  const make = (seconds: number) => new Float32Array(Math.max(1, Math.round(seconds * sr)));
  let out: Float32Array;
  switch (preset) {
    case 'thunder':
    case 'thunder_distant': {
      const far = preset === 'thunder_distant';
      out = make(far ? 6 : 5.5);
      const brown = new Brown();
      const lp = new Svf(sr, far ? 110 : 190, 0.8);
      const mid = new Svf(sr, far ? 180 : 320, 1);
      const pink = new Pink();
      const swells: { at: number; rise: number; decay: number; amp: number }[] = [];
      const count = 3 + Math.floor(rng.next() * 3);
      for (let k = 0; k < count; k++)
        swells.push({
          at: (far ? 0.2 : 0.05) + rng.next() * (far ? 2.8 : 2.2),
          rise: 0.08 + rng.next() * 0.3,
          decay: 0.7 + rng.next() * 1.6,
          amp: 0.4 + rng.next() * 0.6,
        });
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        let env = 0;
        for (const s of swells) {
          if (t < s.at) continue;
          const d = t - s.at;
          env += s.amp * (d < s.rise ? d / s.rise : Math.exp(-(d - s.rise) / s.decay));
        }
        const w = rng.next() * 2 - 1;
        lp.process(brown.next(w));
        mid.process(pink.next(w));
        out[i] = (lp.low * 1.2 + mid.band * (far ? 0.15 : 0.45)) * env * Math.exp(-t / (far ? 3.5 : 3));
      }
      if (!far) {
        burst(out, sr, rng, 0, { freq: 1800, q: 0.5, attack: 0.002, decay: 0.05, amp: 1.4, mode: 'high' });
        burst(out, sr, rng, 0.03, { freq: 600, q: 0.7, attack: 0.005, decay: 0.12, amp: 1.1 });
      }
      break;
    }
    case 'creak':
    case 'door_creak': {
      const door = preset === 'door_creak';
      const dur = door ? 1.3 + rng.next() * 0.4 : 0.5 + rng.next() * 0.7;
      out = make(dur + 0.15);
      renderCreak(out, sr, rng, dur, door);
      break;
    }
    case 'door_open': {
      out = make(1.1);
      burst(out, sr, rng, 0.0, { freq: 2600, q: 8, attack: 0.0005, decay: 0.012, amp: 1.2 });
      glideSine(out, sr, 0.004, 900, 700, 0.001, 0.02, 0.3);
      burst(out, sr, rng, 0.07, { freq: 3100, q: 9, attack: 0.0005, decay: 0.008, amp: 0.7 });
      const creak = make(0.8);
      renderCreak(creak, sr, rng, 0.6, true);
      for (let i = 0; i < creak.length && i + Math.round(0.12 * sr) < out.length; i++)
        out[i + Math.round(0.12 * sr)]! += creak[i]! * 0.45;
      burst(out, sr, rng, 0.2, { freq: 500, q: 0.7, attack: 0.25, decay: 0.2, amp: 0.12 });
      break;
    }
    case 'door_close': {
      out = make(0.9);
      glideSine(out, sr, 0, 72, 42, 0.002, 0.16, 1);
      burst(out, sr, rng, 0, { freq: 380, q: 0.7, attack: 0.001, decay: 0.05, amp: 0.8, mode: 'low' });
      burst(out, sr, rng, 0.012, { freq: 3000, q: 7, attack: 0.0005, decay: 0.01, amp: 0.5 });
      burst(out, sr, rng, 0.06, { freq: 1900, q: 6, attack: 0.001, decay: 0.03, amp: 0.15 });
      break;
    }
    case 'door_locked': {
      out = make(0.6);
      for (let k = 0; k < 3; k++) {
        const at = k * 0.11 + rng.next() * 0.02;
        burst(out, sr, rng, at, { freq: 2300, q: 7, attack: 0.0005, decay: 0.01, amp: 0.9 });
        glideSine(out, sr, at + 0.005, 190, 140, 0.001, 0.035, 0.6);
      }
      break;
    }
    case 'footstep_wood': {
      out = make(0.35);
      const pitch = 0.85 + rng.next() * 0.3;
      glideSine(out, sr, 0.004, 105 * pitch, 68 * pitch, 0.003, 0.05, 0.8);
      burst(out, sr, rng, 0, {
        freq: 1100 * pitch,
        q: 0.7,
        attack: 0.001,
        decay: 0.018,
        amp: 0.55,
        mode: 'low',
      });
      burst(out, sr, rng, 0.002, { freq: 260 * pitch, q: 5, attack: 0.002, decay: 0.07, amp: 0.5 });
      burst(out, sr, rng, 0, { freq: 2600, q: 0.7, attack: 0.0005, decay: 0.004, amp: 0.15, mode: 'high' });
      break;
    }
    case 'gasp': {
      out = make(0.75);
      const f1 = new Svf(sr, 1050, 1.3);
      const f2 = new Svf(sr, 2500, 2);
      const v1 = new Svf(sr, 700, 4);
      let ph = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        const env = t < 0.06 ? t / 0.06 : t < 0.3 ? 1 : Math.max(0, 1 - (t - 0.3) / 0.35);
        const w = rng.next() * 2 - 1;
        f1.process(w);
        f2.process(w);
        ph += (TAU * (190 + 60 * Math.min(1, t / 0.25))) / sr;
        const saw = ((ph / TAU) % 1) * 2 - 1;
        v1.process(saw);
        out[i] = (f1.band * 0.9 + f2.band * 0.5 + v1.band * 0.12 * Math.min(1, t * 8)) * env;
      }
      break;
    }
    case 'cough': {
      out = make(0.7);
      for (const [at, amp] of [
        [0, 1],
        [0.26, 0.7],
      ] as const) {
        const f1 = new Svf(sr, 520, 2.5);
        const f2 = new Svf(sr, 1500, 3);
        let ph = 0;
        const start = Math.round(at * sr);
        const len = Math.round(0.2 * sr);
        for (let i = 0; i < len && start + i < out.length; i++) {
          const t = i / sr;
          const env = t < 0.012 ? t / 0.012 : Math.exp(-(t - 0.012) / 0.06);
          ph += (TAU * 125) / sr;
          const src = (rng.next() * 2 - 1) * 0.75 + (((ph / TAU) % 1) * 2 - 1) * 0.35;
          f1.process(src);
          f2.process(src);
          out[start + i]! += (f1.band + f2.band * 0.6) * env * amp;
        }
      }
      break;
    }
    case 'knife_pickup': {
      out = make(1.0);
      burst(out, sr, rng, 0, { freq: 3600, q: 3, attack: 0.12, decay: 0.03, amp: 0.25 });
      const partials = [2890, 4210, 6150, 8330];
      partials.forEach((f, k) => {
        ping(out, sr, 0.13, f * (0.99 + rng.next() * 0.02), 0.25 / (k + 1) + 0.05, 0.3 / (k + 1));
      });
      break;
    }
    case 'drawer': {
      out = make(0.85);
      const bp = new Svf(sr, 700, 2);
      const grain = smoothCurve(rng, 0.5, 0.02, 1);
      for (let i = 0; i < Math.round(0.45 * sr); i++) {
        const t = i / sr;
        if ((i & 31) === 0) bp.set(600 + 400 * (t / 0.45), 2);
        bp.process(rng.next() * 2 - 1);
        const env = Math.sin((Math.PI * t) / 0.45) ** 0.5;
        out[i]! += bp.band * env * (0.4 + 0.6 * grain(t)) * 0.9;
      }
      glideSine(out, sr, 0.46, 120, 80, 0.002, 0.06, 0.8);
      burst(out, sr, rng, 0.46, { freq: 2200, q: 5, attack: 0.0005, decay: 0.01, amp: 0.4 });
      for (let k = 0; k < 3; k++) ping(out, sr, 0.48 + k * 0.035, 3200 + rng.next() * 1800, 0.02, 0.12);
      break;
    }
    case 'glass_clink': {
      out = make(1.0);
      burst(out, sr, rng, 0, { freq: 5000, q: 1, attack: 0.0003, decay: 0.002, amp: 0.3, mode: 'high' });
      for (const [f, d, a] of [
        [2380, 0.35, 0.3],
        [2392, 0.35, 0.2],
        [3810, 0.25, 0.2],
        [5620, 0.18, 0.14],
        [7700, 0.12, 0.09],
      ] as const)
        ping(out, sr, 0.001, f * (0.995 + rng.next() * 0.01), d, a);
      break;
    }
    case 'whoosh': {
      out = make(0.65);
      const bp = new Svf(sr, 300, 1.4);
      const lp = new Svf(sr, 400, 0.7);
      const dur = 0.6;
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        const k = Math.min(1, t / dur);
        if ((i & 15) === 0) bp.set(250 + 1600 * Math.sin(Math.PI * k) ** 2 + 150 * k, 1.4);
        const w = rng.next() * 2 - 1;
        bp.process(w);
        lp.process(w);
        const env = Math.sin(Math.PI * k) ** 2;
        out[i] = (bp.band + lp.low * 0.3) * env;
      }
      break;
    }
    case 'heartbeat_single': {
      out = make(0.6);
      glideSine(out, sr, 0, 62, 42, 0.008, 0.07, 1);
      burst(out, sr, rng, 0, { freq: 120, q: 0.8, attack: 0.005, decay: 0.03, amp: 0.4, mode: 'low' });
      glideSine(out, sr, 0.27, 78, 52, 0.006, 0.055, 0.7);
      burst(out, sr, rng, 0.27, { freq: 140, q: 0.8, attack: 0.004, decay: 0.025, amp: 0.25, mode: 'low' });
      const lp = new Svf(sr, 170, 0.7);
      for (let i = 0; i < out.length; i++) {
        lp.process(out[i]!);
        out[i] = lp.low;
      }
      break;
    }
    case 'thud_body': {
      out = make(0.9);
      glideSine(out, sr, 0, 55, 36, 0.003, 0.22, 1);
      burst(out, sr, rng, 0, { freq: 260, q: 0.7, attack: 0.002, decay: 0.09, amp: 0.8, mode: 'low' });
      burst(out, sr, rng, 0.01, { freq: 1500, q: 1, attack: 0.01, decay: 0.12, amp: 0.12 });
      glideSine(out, sr, 0.19, 60, 45, 0.003, 0.08, 0.3);
      break;
    }
    case 'breath_in':
    case 'breath_out': {
      const inhale = preset === 'breath_in';
      const dur = inhale ? 0.9 : 1.1;
      out = make(dur);
      const f1 = new Svf(sr, inhale ? 950 : 620, inhale ? 1 : 0.8);
      const f2 = new Svf(sr, inhale ? 2300 : 1500, 1.5);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr / dur;
        const env = inhale
          ? t < 0.55
            ? (t / 0.55) ** 1.5
            : Math.max(0, 1 - (t - 0.55) / 0.45)
          : t < 0.1
            ? t / 0.1
            : Math.max(0, 1 - (t - 0.1) / 0.9) ** 1.4;
        const w = rng.next() * 2 - 1;
        f1.process(w);
        f2.process(w);
        out[i] = (f1.band + f2.band * 0.45) * env;
      }
      break;
    }
    case 'bird_call': {
      out = make(1.2);
      renderBirdCall(out, sr, rng);
      break;
    }
  }
  return normalize(out, STORY_PEAK[preset] ?? 0.6);
}

/** Wood creak: a stick-slip pulse train exciting a few resonances. */
function renderCreak(out: Float32Array, sr: number, rng: Rng, dur: number, door: boolean): void {
  const res = [
    new Svf(sr, door ? 480 : 360, 9),
    new Svf(sr, door ? 1050 : 820, 7),
    new Svf(sr, door ? 1900 : 1500, 6),
  ];
  const gains = [1, 0.6, 0.3];
  const p0 = door ? 0.022 : 0.012 + rng.next() * 0.012;
  const p1 = door ? 0.006 : 0.008 + rng.next() * 0.012;
  const wob = smoothCurve(rng, dur + 0.2, 0.09, 1);
  let next = 0;
  const len = Math.min(out.length, Math.round((dur + 0.12) * sr));
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const k = Math.min(1, t / dur);
    let x = 0;
    if (t >= next && t < dur) {
      x = 1 - rng.next() * 0.3;
      const period = (p0 + (p1 - p0) * k) * (0.85 + 0.3 * wob(t));
      next = t + period * (0.9 + rng.next() * 0.2);
    }
    const env =
      t < 0.06 ? t / 0.06 : t < dur * 0.8 ? 1 : Math.max(0, 1 - (t - dur * 0.8) / (dur * 0.2 + 0.1));
    let y = 0;
    for (let r = 0; r < res.length; r++) {
      res[r]!.process(x);
      y += res[r]!.band * gains[r]!;
    }
    out[i]! += y * env;
  }
}

/** A short songbird phrase: a few chirps with fast frequency sweeps. */
function renderBirdCall(out: Float32Array, sr: number, rng: Rng): void {
  const style = Math.floor(rng.next() * 3);
  let t = 0.01;
  const notes = style === 2 ? 1 : 2 + Math.floor(rng.next() * 4);
  for (let k = 0; k < notes && t < 1; k++) {
    const dur = style === 1 ? 0.18 + rng.next() * 0.12 : style === 2 ? 0.4 : 0.05 + rng.next() * 0.07;
    const fa = 2600 + rng.next() * 2200;
    const fb = fa * (style === 1 ? 1.25 : 0.6 + rng.next() * 0.9);
    const start = Math.round(t * sr);
    const len = Math.round(dur * sr);
    let ph = 0;
    for (let i = 0; i < len && start + i < out.length; i++) {
      const u = i / len;
      const trill = style === 2 ? 0.5 + 0.5 * Math.sin(TAU * 26 * u * dur) : 1;
      const f =
        fa + (fb - fa) * (style === 1 ? Math.sin(u * Math.PI * 0.5) : u) + 60 * Math.sin(TAU * 38 * u * dur);
      ph += (TAU * f) / sr;
      out[start + i]! += Math.sin(ph) * Math.sin(Math.PI * u) ** 2 * trill;
    }
    t += dur + 0.03 + rng.next() * 0.08;
  }
}
