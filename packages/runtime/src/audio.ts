import { Rng } from './math.ts';
import { SFX_PRESETS, type SfxPreset } from './types.ts';

export interface PlayOptions {
  /** 0..1 (default 1). */
  volume?: number;
  loop?: boolean;
  /** Playback rate / pitch multiplier (default 1). */
  pitch?: number;
}

export interface AudioBackend {
  /** Plays an audio file (project-relative path, e.g. 'audio/music.ogg'). */
  play(clip: string, opts?: PlayOptions): void;
  /** Plays a synthesized sound effect preset. */
  sfx(preset: SfxPreset, opts?: PlayOptions): void;
  stopAll(): void;
  dispose?(): void;
}

export interface AudioCall {
  kind: 'play' | 'sfx' | 'stop';
  name: string;
  opts: PlayOptions;
}

/** Silent backend that records every call (headless runs). */
export class NullAudio implements AudioBackend {
  readonly calls: AudioCall[] = [];
  /** Keeps at most this many calls. */
  limit = 5000;
  play(clip: string, opts: PlayOptions = {}): void {
    if (this.calls.length < this.limit) this.calls.push({ kind: 'play', name: clip, opts: { ...opts } });
  }
  sfx(preset: SfxPreset, opts: PlayOptions = {}): void {
    if (this.calls.length < this.limit) this.calls.push({ kind: 'sfx', name: preset, opts: { ...opts } });
  }
  stopAll(): void {
    if (this.calls.length < this.limit) this.calls.push({ kind: 'stop', name: '*', opts: {} });
  }
}

// ---------------------------------------------------------------------------------------------
// Tiny jsfxr-style synthesizer (isomorphic: returns raw samples)
// ---------------------------------------------------------------------------------------------

type Wave = 'square' | 'saw' | 'sine' | 'triangle' | 'noise';

interface SfxParams {
  wave: Wave;
  /** Frequencies (Hz) played in sequence over the sound (arpeggio); one entry = constant pitch. */
  notes: number[];
  /** Frequency multiplier reached at the end (slide). 1 = none. */
  slide: number;
  attack: number;
  sustain: number;
  decay: number;
  duty: number;
  vibratoDepth: number;
  vibratoSpeed: number;
  volume: number;
  /** One-pole low-pass cutoff 0..1 (1 = off). */
  lowpass: number;
}

const PRESETS: Record<SfxPreset, SfxParams> = {
  coin: {
    wave: 'square',
    notes: [988, 1319],
    slide: 1,
    attack: 0,
    sustain: 0.06,
    decay: 0.22,
    duty: 0.5,
    vibratoDepth: 0,
    vibratoSpeed: 0,
    volume: 0.35,
    lowpass: 1,
  },
  jump: {
    wave: 'square',
    notes: [280],
    slide: 2.2,
    attack: 0,
    sustain: 0.05,
    decay: 0.18,
    duty: 0.35,
    vibratoDepth: 0,
    vibratoSpeed: 0,
    volume: 0.3,
    lowpass: 1,
  },
  hit: {
    wave: 'noise',
    notes: [900],
    slide: 0.3,
    attack: 0,
    sustain: 0.03,
    decay: 0.14,
    duty: 0.5,
    vibratoDepth: 0,
    vibratoSpeed: 0,
    volume: 0.45,
    lowpass: 0.6,
  },
  explosion: {
    wave: 'noise',
    notes: [320],
    slide: 0.25,
    attack: 0,
    sustain: 0.12,
    decay: 0.6,
    duty: 0.5,
    vibratoDepth: 0,
    vibratoSpeed: 0,
    volume: 0.55,
    lowpass: 0.25,
  },
  powerup: {
    wave: 'square',
    notes: [440, 554, 659, 880],
    slide: 1.3,
    attack: 0,
    sustain: 0.3,
    decay: 0.15,
    duty: 0.4,
    vibratoDepth: 0.03,
    vibratoSpeed: 14,
    volume: 0.3,
    lowpass: 1,
  },
  laser: {
    wave: 'saw',
    notes: [1400],
    slide: 0.2,
    attack: 0,
    sustain: 0.04,
    decay: 0.16,
    duty: 0.5,
    vibratoDepth: 0,
    vibratoSpeed: 0,
    volume: 0.25,
    lowpass: 0.9,
  },
  click: {
    wave: 'square',
    notes: [1000],
    slide: 1,
    attack: 0,
    sustain: 0.01,
    decay: 0.03,
    duty: 0.5,
    vibratoDepth: 0,
    vibratoSpeed: 0,
    volume: 0.25,
    lowpass: 1,
  },
  win: {
    wave: 'square',
    notes: [523, 659, 784, 1047],
    slide: 1,
    attack: 0.01,
    sustain: 0.5,
    decay: 0.3,
    duty: 0.5,
    vibratoDepth: 0.01,
    vibratoSpeed: 8,
    volume: 0.3,
    lowpass: 0.9,
  },
  lose: {
    wave: 'saw',
    notes: [392, 330, 262],
    slide: 0.7,
    attack: 0.01,
    sustain: 0.5,
    decay: 0.35,
    duty: 0.5,
    vibratoDepth: 0.04,
    vibratoSpeed: 6,
    volume: 0.3,
    lowpass: 0.5,
  },
};

/** Synthesizes a preset into mono samples in -1..1. Deterministic. */
export function synthesizeSfx(preset: SfxPreset, sampleRate = 44100, seed = 1): Float32Array {
  const p = PRESETS[preset] ?? PRESETS.click;
  const total = p.attack + p.sustain + p.decay;
  const n = Math.max(1, Math.floor(total * sampleRate));
  const out = new Float32Array(n);
  const rng = new Rng(seed);
  let phase = 0;
  let noise = rng.next() * 2 - 1;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const k = t / total;
    const note = p.notes[Math.min(p.notes.length - 1, Math.floor(k * p.notes.length))]!;
    let freq = note * p.slide ** k;
    if (p.vibratoDepth > 0) freq *= 1 + p.vibratoDepth * Math.sin(2 * Math.PI * p.vibratoSpeed * t);
    const prevPhase = phase;
    phase = (phase + freq / sampleRate) % 1;
    let s: number;
    switch (p.wave) {
      case 'square':
        s = phase < p.duty ? 1 : -1;
        break;
      case 'saw':
        s = 2 * phase - 1;
        break;
      case 'sine':
        s = Math.sin(2 * Math.PI * phase);
        break;
      case 'triangle':
        s = 1 - 4 * Math.abs(phase - 0.5);
        break;
      default:
        // pitch-controlled noise: new random value twice per period
        if ((phase < prevPhase || (prevPhase < 0.5 && phase >= 0.5)) && i > 0) noise = rng.next() * 2 - 1;
        s = noise;
    }
    const env =
      t < p.attack
        ? t / p.attack
        : t < p.attack + p.sustain
          ? 1
          : Math.max(0, 1 - (t - p.attack - p.sustain) / p.decay);
    lp += (s - lp) * p.lowpass;
    out[i] = Math.max(-1, Math.min(1, lp * env * p.volume));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Web Audio backend (browser)
// ---------------------------------------------------------------------------------------------

export interface WebAudioOptions {
  /** Maps a project-relative clip path to a URL (default: the path itself). */
  resolveUrl?: (path: string) => string;
  /** Use an existing AudioContext. Created lazily on first use otherwise. */
  context?: AudioContext;
  /** Master volume 0..1 (default 0.8). */
  volume?: number;
}

/** Plays clips via fetch + decodeAudioData and sfx presets via the built-in synthesizer. */
export class WebAudioBackend implements AudioBackend {
  private ctx: AudioContext | null;
  private readonly ownsContext: boolean;
  private master: GainNode | null = null;
  private readonly resolveUrl: (path: string) => string;
  private readonly volume: number;
  private readonly sfxCache = new Map<string, AudioBuffer>();
  private readonly clipCache = new Map<string, Promise<AudioBuffer | null>>();
  private readonly playing = new Set<AudioBufferSourceNode>();

  constructor(opts: WebAudioOptions = {}) {
    this.ctx = opts.context ?? null;
    this.ownsContext = !opts.context;
    this.resolveUrl = opts.resolveUrl ?? ((p) => p);
    this.volume = opts.volume ?? 0.8;
  }

  private context(): AudioContext | null {
    if (!this.ctx) {
      const Ctor = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor() as AudioContext;
    }
    if (!this.master) {
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  private start(buffer: AudioBuffer, opts: PlayOptions): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = !!opts.loop;
    src.playbackRate.value = opts.pitch ?? 1;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, opts.volume ?? 1));
    src.connect(gain).connect(this.master!);
    src.onended = () => this.playing.delete(src);
    this.playing.add(src);
    src.start();
  }

  sfx(preset: SfxPreset, opts: PlayOptions = {}): void {
    const ctx = this.context();
    if (!ctx) return;
    let buf = this.sfxCache.get(preset);
    if (!buf) {
      const data = synthesizeSfx(preset, ctx.sampleRate);
      buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.getChannelData(0).set(data);
      this.sfxCache.set(preset, buf);
    }
    this.start(buf, opts);
  }

  play(clip: string, opts: PlayOptions = {}): void {
    const ctx = this.context();
    if (!ctx) return;
    let p = this.clipCache.get(clip);
    if (!p) {
      p = fetch(this.resolveUrl(clip))
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((b) => ctx.decodeAudioData(b))
        .catch((err) => {
          console.warn(`[aige] could not load audio '${clip}': ${err?.message ?? err}`);
          return null;
        });
      this.clipCache.set(clip, p);
    }
    void p.then((buf) => {
      if (buf) this.start(buf, opts);
    });
  }

  stopAll(): void {
    for (const s of this.playing) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.playing.clear();
  }

  dispose(): void {
    this.stopAll();
    if (this.ownsContext) {
      void this.ctx?.close().catch(() => {});
      this.ctx = null;
    }
    this.master = null;
  }
}

export function isSfxPreset(name: unknown): name is SfxPreset {
  return typeof name === 'string' && (SFX_PRESETS as readonly string[]).includes(name);
}
