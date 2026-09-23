import {
  type AmbienceKind,
  EVENT_ONLY_AMBIENCE,
  isStorySfx,
  renderAmbienceLoop,
  type StorySfx,
  synthStorySfx,
} from './ambience.ts';
import { Rng } from './math.ts';
import { ARCADE_SFX, type ArcadeSfx, SFX_PRESETS, type SfxPreset } from './types.ts';

export interface PlayOptions {
  /** 0..1 (default 1). */
  volume?: number;
  loop?: boolean;
  /** Playback rate / pitch multiplier (default 1). */
  pitch?: number;
  /** World position for spatial sounds (they fade out with distance from the listener = the camera). */
  position?: [number, number, number];
  /** Spatial: distance in meters at which the sound is inaudible (default 15). */
  range?: number;
}

export interface AmbienceOptions {
  /** 0..1 (default 0.8). */
  volume?: number;
  /** World position for spatial ambiences (null/undefined = everywhere, e.g. wind or a heartbeat). */
  position?: [number, number, number] | null;
  /** Spatial: fade-out distance in meters (default 12). */
  range?: number;
  /** Initial parameters: heartbeat 'rate' (bpm), breathing 'intensity' (0..1). */
  params?: Record<string, number>;
}

/** The ear: the camera pose, updated every frame. */
export interface AudioListener {
  position: [number, number, number];
  forward: [number, number, number];
  right: [number, number, number];
}

export interface AudioBackend {
  /** Plays an audio file (project-relative path, e.g. 'audio/music.ogg'). */
  play(clip: string, opts?: PlayOptions): void;
  /** Plays a synthesized sound effect preset. */
  sfx(preset: SfxPreset, opts?: PlayOptions): void;
  stopAll(): void;
  dispose?(): void;
  /** Stops every playing instance of a clip (e.g. a voice line when a cutscene is skipped). */
  stopClip?(clip: string): void;
  /** Starts a looping procedural ambience under an id (restarts it if the id exists). */
  ambience?(id: string, kind: AmbienceKind, opts?: AmbienceOptions): void;
  stopAmbience?(id: string, fadeSeconds?: number): void;
  /** Changes an ambience parameter: 'volume' (0..1), 'rate' (heartbeat bpm), 'intensity' (breathing 0..1). */
  setAmbience?(id: string, param: string, value: number, seconds?: number): void;
  /** Moves a spatial ambience. */
  moveAmbience?(id: string, position: [number, number, number] | null): void;
  /** Fades the master bus, or the 'world' bus (everything except heartbeat/breathing). */
  fadeBus?(bus: 'master' | 'world', volume: number, seconds: number): void;
  setListener?(listener: AudioListener): void;
  /** Called once per frame: spatial gains and scheduled ambience events (creaks, birds, beats). */
  update?(): void;
}

export interface AudioCall {
  kind: 'play' | 'sfx' | 'stop' | 'stopClip' | 'ambience' | 'ambienceStop' | 'param' | 'fade';
  name: string;
  opts: PlayOptions & Record<string, unknown>;
}

/** Silent backend that records every call (headless runs). */
export class NullAudio implements AudioBackend {
  readonly calls: AudioCall[] = [];
  /** Keeps at most this many calls. */
  limit = 5000;
  /** Ambiences currently "playing": id -> { kind, params }. */
  readonly ambiences = new Map<
    string,
    { kind: AmbienceKind; volume: number; params: Record<string, number> }
  >();
  listener: AudioListener | null = null;
  private push(call: AudioCall): void {
    if (this.calls.length < this.limit) this.calls.push(call);
  }
  play(clip: string, opts: PlayOptions = {}): void {
    this.push({ kind: 'play', name: clip, opts: { ...opts } });
  }
  sfx(preset: SfxPreset, opts: PlayOptions = {}): void {
    this.push({ kind: 'sfx', name: preset, opts: { ...opts } });
  }
  stopAll(): void {
    this.push({ kind: 'stop', name: '*', opts: {} });
  }
  stopClip(clip: string): void {
    this.push({ kind: 'stopClip', name: clip, opts: {} });
  }
  ambience(id: string, kind: AmbienceKind, opts: AmbienceOptions = {}): void {
    this.ambiences.set(id, { kind, volume: opts.volume ?? 0.8, params: { ...(opts.params ?? {}) } });
    this.push({ kind: 'ambience', name: kind, opts: { id, volume: opts.volume ?? 0.8 } });
  }
  stopAmbience(id: string): void {
    this.ambiences.delete(id);
    this.push({ kind: 'ambienceStop', name: id, opts: {} });
  }
  setAmbience(id: string, param: string, value: number, seconds = 0): void {
    const a = this.ambiences.get(id);
    if (a) {
      if (param === 'volume') a.volume = value;
      else a.params[param] = value;
    }
    this.push({ kind: 'param', name: id, opts: { param, value, seconds } });
  }
  fadeBus(bus: 'master' | 'world', volume: number, seconds: number): void {
    this.push({ kind: 'fade', name: bus, opts: { volume, seconds } });
  }
  setListener(listener: AudioListener): void {
    this.listener = listener;
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

const PRESETS: Record<ArcadeSfx, SfxParams> = {
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

/** Synthesizes a preset into mono samples in -1..1. Deterministic (`seed` varies story presets). */
export function synthesizeSfx(preset: SfxPreset, sampleRate = 44100, seed = 1): Float32Array {
  if (isStorySfx(preset)) return synthStorySfx(preset as StorySfx, sampleRate, seed);
  const p = PRESETS[preset as ArcadeSfx] ?? PRESETS.click;
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

/** Distance attenuation 0..1 for a spatial source (smooth, reaches 0 at `range`). */
export function spatialGain(distance: number, range: number): number {
  const r = Math.max(0.1, range);
  const x = Math.max(0, Math.min(1, distance / r));
  // near field stays loud, then a smooth roll-off to silence at the range
  return (1 - x) ** 2 / (1 + 2 * x);
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

type V3 = [number, number, number];

interface AmbienceVoice {
  id: string;
  kind: AmbienceKind;
  volume: number;
  position: V3 | null;
  range: number;
  params: Record<string, number>;
  gain: GainNode;
  panner: StereoPannerNode | null;
  source: AudioBufferSourceNode | null;
  rng: Rng;
  nextEvent: number;
  /** Breathing: next phase is an exhale. */
  exhale: boolean;
}

/** Kinds that sit on the 'body' bus (not ducked by fadeBus('world')). */
const BODY_KINDS: readonly AmbienceKind[] = ['heartbeat', 'breathing'];

/**
 * Plays clips via fetch + decodeAudioData, sfx presets via the built-in synthesizers, and looping
 * procedural ambiences (wind, storm, rain on the window, fridge hum, creaks, birds, heartbeat...).
 * Spatial sounds fade with distance from the listener (the camera) and pan left/right.
 */
export class WebAudioBackend implements AudioBackend {
  private ctx: AudioContext | null;
  private readonly ownsContext: boolean;
  private master: GainNode | null = null;
  private worldBus: GainNode | null = null;
  private bodyBus: GainNode | null = null;
  private readonly resolveUrl: (path: string) => string;
  private readonly volume: number;
  private readonly sfxCache = new Map<string, AudioBuffer[]>();
  private readonly loopCache = new Map<AmbienceKind, AudioBuffer | null>();
  private readonly clipCache = new Map<string, Promise<AudioBuffer | null>>();
  private readonly playing = new Map<AudioBufferSourceNode, string>();
  private readonly voices = new Map<string, AmbienceVoice>();
  private listener: AudioListener | null = null;
  private variant = 0;

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
      this.worldBus = this.ctx.createGain();
      this.worldBus.connect(this.master);
      this.bodyBus = this.ctx.createGain();
      this.bodyBus.connect(this.master);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** Resumes the audio context (call from a user gesture). */
  resume(): void {
    this.context();
  }

  /** Gain + stereo pan for a world position, relative to the listener. */
  private spatial(position: V3 | null | undefined, range: number): { gain: number; pan: number } {
    const l = this.listener;
    if (!position || !l) return { gain: 1, pan: 0 };
    const dx = position[0] - l.position[0];
    const dy = position[1] - l.position[1];
    const dz = position[2] - l.position[2];
    const d = Math.hypot(dx, dy, dz);
    const pan = d > 1e-3 ? ((dx * l.right[0] + dy * l.right[1] + dz * l.right[2]) / d) * 0.75 : 0;
    return { gain: spatialGain(d, range), pan: Math.max(-1, Math.min(1, pan)) };
  }

  private start(
    buffer: AudioBuffer,
    opts: PlayOptions,
    name: string,
    dest?: AudioNode,
    when = 0,
  ): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = !!opts.loop;
    src.playbackRate.value = opts.pitch ?? 1;
    const gain = ctx.createGain();
    const sp = this.spatial(opts.position, opts.range ?? 15);
    gain.gain.value = Math.max(0, Math.min(1, opts.volume ?? 1)) * sp.gain;
    let node: AudioNode = src.connect(gain);
    if (opts.position && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = sp.pan;
      node = node.connect(p);
    }
    node.connect(dest ?? this.worldBus!);
    src.onended = () => this.playing.delete(src);
    this.playing.set(src, name);
    src.start(when);
    return src;
  }

  private sfxBuffer(preset: SfxPreset): AudioBuffer {
    const ctx = this.ctx!;
    let list = this.sfxCache.get(preset);
    if (!list) {
      // story presets get a few variations (footsteps, creaks never sound identical)
      const variants = isStorySfx(preset) && preset !== 'thunder' ? 4 : 1;
      list = [];
      for (let v = 0; v < variants; v++) {
        const data = synthesizeSfx(preset, ctx.sampleRate, v + 1);
        const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
        buf.getChannelData(0).set(data);
        list.push(buf);
      }
      this.sfxCache.set(preset, list);
    }
    return list[this.variant++ % list.length]!;
  }

  sfx(preset: SfxPreset, opts: PlayOptions = {}): void {
    const ctx = this.context();
    if (!ctx) return;
    const name = (SFX_PRESETS as readonly string[]).includes(preset) ? preset : ARCADE_SFX[6];
    this.start(this.sfxBuffer(name as SfxPreset), opts, `sfx:${name}`);
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
      if (buf) this.start(buf, opts, clip);
    });
  }

  stopClip(clip: string): void {
    for (const [src, name] of this.playing) {
      if (name !== clip) continue;
      try {
        src.stop();
      } catch {
        // already stopped
      }
      this.playing.delete(src);
    }
  }

  stopAll(): void {
    for (const s of this.playing.keys()) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.playing.clear();
    for (const id of [...this.voices.keys()]) this.stopAmbience(id, 0);
  }

  // -------------------------------------------------------------------------------------------
  // Ambience
  // -------------------------------------------------------------------------------------------

  private loopBuffer(kind: AmbienceKind): AudioBuffer | null {
    const ctx = this.ctx!;
    if (this.loopCache.has(kind)) return this.loopCache.get(kind)!;
    let buf: AudioBuffer | null = null;
    if (!EVENT_ONLY_AMBIENCE.includes(kind)) {
      const data = renderAmbienceLoop(kind, ctx.sampleRate);
      buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.getChannelData(0).set(data);
    }
    this.loopCache.set(kind, buf);
    return buf;
  }

  ambience(id: string, kind: AmbienceKind, opts: AmbienceOptions = {}): void {
    const ctx = this.context();
    if (!ctx) return;
    if (this.voices.has(id)) this.stopAmbience(id, 0);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = opts.position && ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) gain.connect(panner).connect(BODY_KINDS.includes(kind) ? this.bodyBus! : this.worldBus!);
    else gain.connect(BODY_KINDS.includes(kind) ? this.bodyBus! : this.worldBus!);
    const buf = this.loopBuffer(kind);
    let source: AudioBufferSourceNode | null = null;
    if (buf) {
      source = ctx.createBufferSource();
      source.buffer = buf;
      source.loop = true;
      source.connect(gain);
      // random start offset so two sources of the same kind do not phase
      source.start(0, Math.random() * buf.duration);
    }
    const voice: AmbienceVoice = {
      id,
      kind,
      volume: Math.max(0, Math.min(1, opts.volume ?? 0.8)),
      position: opts.position ?? null,
      range: opts.range ?? 12,
      params: { rate: 62, intensity: 0.5, ...(opts.params ?? {}) },
      gain,
      panner,
      source,
      rng: new Rng((Math.random() * 1e9) | 0),
      nextEvent:
        ctx.currentTime +
        (kind === 'storm'
          ? 5 + Math.random() * 7
          : kind === 'creaks'
            ? 1 + Math.random() * 3
            : 0.1 + Math.random() * 0.5),
      exhale: false,
    };
    this.voices.set(id, voice);
    this.applySpatial(voice, 0.4);
  }

  stopAmbience(id: string, fadeSeconds = 0.5): void {
    const v = this.voices.get(id);
    if (!v || !this.ctx) return;
    this.voices.delete(id);
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, t + Math.max(0.01, fadeSeconds));
    const src = v.source;
    setTimeout(
      () => {
        try {
          src?.stop();
        } catch {
          // already stopped
        }
        v.gain.disconnect();
      },
      Math.max(20, fadeSeconds * 1000 + 50),
    );
  }

  setAmbience(id: string, param: string, value: number, seconds = 0): void {
    const v = this.voices.get(id);
    if (!v) return;
    if (param === 'volume') {
      v.volume = Math.max(0, Math.min(1, value));
      this.applySpatial(v, Math.max(0.05, seconds));
    } else v.params[param] = value;
  }

  moveAmbience(id: string, position: V3 | null): void {
    const v = this.voices.get(id);
    if (v) v.position = position;
  }

  fadeBus(bus: 'master' | 'world', volume: number, seconds: number): void {
    const ctx = this.context();
    if (!ctx) return;
    const node = bus === 'master' ? this.master! : this.worldBus!;
    const target = Math.max(0, Math.min(1, volume)) * (bus === 'master' ? this.volume : 1);
    const t = ctx.currentTime;
    node.gain.cancelScheduledValues(t);
    node.gain.setValueAtTime(node.gain.value, t);
    node.gain.linearRampToValueAtTime(target, t + Math.max(0.01, seconds));
  }

  setListener(listener: AudioListener): void {
    this.listener = listener;
  }

  private applySpatial(v: AmbienceVoice, smoothing: number): void {
    if (!this.ctx) return;
    const sp = this.spatial(v.position, v.range);
    const t = this.ctx.currentTime;
    v.gain.gain.setTargetAtTime(v.volume * sp.gain, t, smoothing / 3);
    if (v.panner) v.panner.pan.setTargetAtTime(sp.pan, t, 0.05);
  }

  update(): void {
    const ctx = this.ctx;
    if (!ctx || this.voices.size === 0) return;
    const now = ctx.currentTime;
    for (const v of this.voices.values()) {
      this.applySpatial(v, 0.15);
      // schedule the next few seconds of events for event-driven ambiences
      let guard = 0;
      while (v.nextEvent < now + 0.25 && guard++ < 8) {
        const at = Math.max(now, v.nextEvent);
        v.nextEvent = at + this.scheduleEvent(v, at);
      }
    }
  }

  /** Plays one event for an ambience at `at` (context time) and returns the delay to the next one. */
  private scheduleEvent(v: AmbienceVoice, at: number): number {
    const r = () => v.rng.next();
    const play = (preset: SfxPreset, volume: number, pitch = 1) =>
      this.start(this.sfxBuffer(preset), { volume, pitch }, `amb:${v.id}`, v.gain, at);
    switch (v.kind) {
      case 'heartbeat': {
        const bpm = Math.max(20, Math.min(220, v.params.rate ?? 62));
        play('heartbeat_single', 0.7 + 0.3 * Math.min(1, v.params.intensity ?? 0.5), 0.95 + bpm / 1200);
        return 60 / bpm;
      }
      case 'breathing': {
        const k = Math.max(0, Math.min(1, v.params.intensity ?? 0.5));
        const period = 4.2 - 2.7 * k;
        v.exhale = !v.exhale;
        play(v.exhale ? 'breath_in' : 'breath_out', 0.35 + 0.65 * k, 0.92 + 0.2 * k + r() * 0.04);
        return v.exhale ? period * 0.42 : period * 0.58;
      }
      case 'creaks':
        play(r() < 0.25 ? 'door_creak' : 'creak', 0.25 + 0.75 * r() ** 2, 0.8 + 0.4 * r());
        return 2.5 + 9 * r();
      case 'birds':
        play('bird_call', 0.3 + 0.7 * r(), 0.9 + 0.25 * r());
        return r() < 0.3 ? 0.25 + 0.4 * r() : 1 + 3.5 * r();
      case 'storm':
        play('thunder_distant', 0.5 + 0.5 * r(), 0.85 + 0.3 * r());
        return 9 + 17 * r();
      default:
        return 3600;
    }
  }

  dispose(): void {
    this.stopAll();
    if (this.ownsContext) {
      void this.ctx?.close().catch(() => {});
      this.ctx = null;
    }
    this.master = null;
    this.worldBus = null;
    this.bodyBus = null;
  }
}

export function isSfxPreset(name: unknown): name is SfxPreset {
  return typeof name === 'string' && (SFX_PRESETS as readonly string[]).includes(name);
}
