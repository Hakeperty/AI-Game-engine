// Screen effects: full-screen post-processing state (fade, vignette, blur, flash...) driven by
// scripts and cutscenes, rendered by @aige/render's PostFx pass. Pure data + tweens, so it runs
// headless and play-test captures can reproduce exactly what the player sees.

/** Current strength of every screen effect. 0 = off. Rendered by the post-processing pass. */
export interface ScreenFx {
  /** 0 = clear, 1 = fully faded to `fadeColor` (black by default). */
  fade: number;
  fadeColor: string;
  /** Dark edges. */
  vignette: number;
  /** Blurry vision (fainting, drunk, waking up). */
  blur: number;
  /** Darkens the whole image. */
  darken: number;
  /** 0 = color, 1 = black and white. */
  desaturate: number;
  /** White (or `flashColor`) overlay; flashes decay back to 0 by themselves. */
  flash: number;
  flashColor: string;
  /** Cinematic black bars (0..1 of the bar height). */
  letterbox: number;
  /** Camera shake strength. */
  shake: number;
  /** Heartbeat pulse strength (edges pulse and darken with every beat). */
  heartbeat: number;
  /** Heart rate in beats per minute for the pulse. */
  heartRate: number;
  /** Exposure multiplier on top of the scene's Environment (1 = unchanged). */
  exposure: number;
  /** Fog density multiplier (1 = the Environment's fog). */
  fog: number;
  /** Extra bloom strength. */
  bloom: number;
  /** Contrast and saturation multipliers (1 = unchanged). */
  contrast: number;
  saturation: number;
  /** Added color temperature (-1 cold .. +1 warm) and tint (-1 green .. +1 magenta). */
  temperature: number;
  tint: number;
  /** Extra film grain. */
  grain: number;
  /** Depth of field: focus distance in meters (0 = off) and blur strength. */
  focus: number;
  aperture: number;
}

export type ScreenEffect =
  | 'fade'
  | 'vignette'
  | 'blur'
  | 'darken'
  | 'desaturate'
  | 'flash'
  | 'letterbox'
  | 'shake'
  | 'heartbeat'
  | 'heartRate'
  | 'exposure'
  | 'fog'
  | 'bloom'
  | 'contrast'
  | 'saturation'
  | 'temperature'
  | 'tint'
  | 'grain'
  | 'focus'
  | 'aperture';

export const SCREEN_EFFECTS: readonly ScreenEffect[] = [
  'fade',
  'vignette',
  'blur',
  'darken',
  'desaturate',
  'flash',
  'letterbox',
  'shake',
  'heartbeat',
  'heartRate',
  'exposure',
  'fog',
  'bloom',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'grain',
  'focus',
  'aperture',
];

/** Valid range of each effect value. */
export const SCREEN_RANGES: Record<ScreenEffect, [number, number]> = {
  fade: [0, 1],
  vignette: [0, 1],
  blur: [0, 1],
  darken: [0, 1],
  desaturate: [0, 1],
  flash: [0, 1],
  letterbox: [0, 1],
  shake: [0, 1],
  heartbeat: [0, 1],
  heartRate: [10, 240],
  exposure: [0, 8],
  fog: [0, 20],
  bloom: [0, 3],
  contrast: [0, 2],
  saturation: [0, 2],
  temperature: [-1, 1],
  tint: [-1, 1],
  grain: [0, 1],
  focus: [0, 1000],
  aperture: [0, 1],
};

export type Ease = 'linear' | 'in' | 'out' | 'inOut' | 'hold';

/** Easing curve: maps 0..1 to 0..1. 'hold' stays at 0 until the end. */
export function ease(kind: Ease | string | undefined, u: number): number {
  const t = Math.max(0, Math.min(1, u));
  switch (kind) {
    case 'linear':
      return t;
    case 'in':
      return t * t * t;
    case 'out':
      return 1 - (1 - t) ** 3;
    case 'hold':
      return t >= 1 ? 1 : 0;
    default:
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  }
}

export function defaultScreenFx(): ScreenFx {
  return {
    fade: 0,
    fadeColor: '#000000',
    vignette: 0,
    blur: 0,
    darken: 0,
    desaturate: 0,
    flash: 0,
    flashColor: '#ffffff',
    letterbox: 0,
    shake: 0,
    heartbeat: 0,
    heartRate: 60,
    exposure: 1,
    fog: 1,
    bloom: 0,
    contrast: 1,
    saturation: 1,
    temperature: 0,
    tint: 0,
    grain: 0,
    focus: 0,
    aperture: 0,
  };
}

/** True when the screen state changes nothing (renderers can skip post-processing). */
export function isNeutralScreen(s: ScreenFx): boolean {
  return (
    s.fade < 1e-3 &&
    s.vignette < 1e-3 &&
    s.blur < 1e-3 &&
    s.darken < 1e-3 &&
    s.desaturate < 1e-3 &&
    s.flash < 1e-3 &&
    s.letterbox < 1e-3 &&
    s.heartbeat < 1e-3 &&
    Math.abs(s.exposure - 1) < 1e-3 &&
    Math.abs(s.contrast - 1) < 1e-3 &&
    Math.abs(s.saturation - 1) < 1e-3 &&
    Math.abs(s.temperature) < 1e-3 &&
    Math.abs(s.tint) < 1e-3 &&
    s.bloom < 1e-3 &&
    s.grain < 1e-3 &&
    s.focus < 1e-3
  );
}

interface Tween {
  from: number;
  to: number;
  start: number;
  duration: number;
  ease: Ease;
  /** After reaching `to`, decay back to 0 over this many seconds (flash, shake bursts). */
  decay?: number;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const clampTo = (effect: ScreenEffect, v: number) => {
  const [lo, hi] = SCREEN_RANGES[effect];
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
};

/** Owns the ScreenFx state and its tweens. Advanced by the world every frame (simulated time). */
export class ScreenController {
  readonly state: ScreenFx = defaultScreenFx();
  private readonly tweens = new Map<ScreenEffect, Tween>();
  private time = 0;

  /** Advances tweens by `dt` seconds. */
  update(dt: number): void {
    this.time += Math.max(0, dt);
    for (const [key, tw] of this.tweens) {
      const el = this.time - tw.start;
      if (el < tw.duration) {
        this.write(key, tw.from + (tw.to - tw.from) * ease(tw.ease, el / Math.max(1e-6, tw.duration)));
        continue;
      }
      if (tw.decay && tw.decay > 0) {
        const d = el - tw.duration;
        if (d < tw.decay) {
          this.write(key, tw.to * (1 - ease('out', d / tw.decay)));
          continue;
        }
        this.write(key, 0);
      } else this.write(key, tw.to);
      this.tweens.delete(key);
    }
  }

  /** Tweens an effect to `to` over `seconds` (0 = instantly). */
  tween(effect: ScreenEffect, to: number, seconds = 0.5, easing: Ease = 'inOut', decay?: number): void {
    if (!SCREEN_EFFECTS.includes(effect)) return;
    const target = clampTo(effect, to);
    const from = this.state[effect] as number;
    const duration = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    if (duration <= 0 && !decay) {
      this.tweens.delete(effect);
      this.write(effect, target);
      return;
    }
    const tw: Tween = { from, to: target, start: this.time, duration, ease: easing };
    if (decay) tw.decay = decay;
    this.tweens.set(effect, tw);
    if (duration <= 0) this.write(effect, target);
  }

  /** Sets an effect instantly (cancels its tween). */
  set(effect: ScreenEffect, value: number): void {
    this.tween(effect, value, 0);
  }

  /** A burst: jumps to `strength`, then decays to 0 over `seconds` (flash, shake). */
  burst(effect: 'flash' | 'shake', strength: number, seconds: number): void {
    this.tweens.delete(effect);
    this.write(effect, clamp01(strength));
    this.tweens.set(effect, {
      from: clamp01(strength),
      to: clamp01(strength),
      start: this.time,
      duration: 0,
      ease: 'linear',
      decay: Math.max(0.01, seconds),
    });
  }

  setColor(which: 'fade' | 'flash', color: string | undefined): void {
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
    if (which === 'fade') this.state.fadeColor = color.toLowerCase();
    else this.state.flashColor = color.toLowerCase();
  }

  /** True while any effect is animating. */
  get animating(): boolean {
    return this.tweens.size > 0;
  }

  /** Jumps every running tween to its end value (used when a cutscene is skipped). */
  finish(): void {
    for (const [key, tw] of this.tweens) this.write(key, tw.decay ? 0 : tw.to);
    this.tweens.clear();
  }

  reset(): void {
    this.tweens.clear();
    Object.assign(this.state, defaultScreenFx());
  }

  snapshot(): ScreenFx {
    const s = { ...this.state };
    for (const k of SCREEN_EFFECTS)
      (s as unknown as Record<string, number>)[k] = Math.round(s[k] * 1e4) / 1e4;
    return s;
  }

  private write(key: ScreenEffect, v: number): void {
    (this.state as unknown as Record<string, number>)[key] = v;
  }
}
