import type { Vector3 } from 'three';
import type { PlayOptions } from './audio.ts';
import { requireWorld } from './context.ts';
import type { RuntimeEntity } from './entity.ts';
import type { QueryOptions, RaycastHit } from './physics.ts';
import type { GameOver, HudEntry, SfxPreset, Vec3Like } from './types.ts';
import type { FindQuery, InstantiateOptions } from './world.ts';

// Singletons that act on the currently running World (see context.ts). They are plain objects so
// the host can hand the whole API to sandboxed scripts as one global.

/** Keyboard, mouse and gamepad input, mapped through project.input (actions and axes). */
export const Input = {
  /** Axis value -1..1, e.g. Input.axis('move_x'). */
  axis(name: string): number {
    return requireWorld('Input').input.axis(name);
  },
  /** Two axes as a vector with length <= 1 (default move_x / move_y). */
  vector(xAxis = 'move_x', yAxis = 'move_y'): { x: number; y: number } {
    const inp = requireWorld('Input').input;
    let x = inp.axis(xAxis);
    let y = inp.axis(yAxis);
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  },
  /** Action is held down, e.g. Input.held('sprint'). */
  held(action: string): boolean {
    return requireWorld('Input').input.held(action);
  },
  /** Action went down this frame, e.g. Input.pressed('jump'). */
  pressed(action: string): boolean {
    return requireWorld('Input').input.pressed(action);
  },
  /** Action went up this frame. */
  released(action: string): boolean {
    return requireWorld('Input').input.released(action);
  },
  /** Raw key/button held: 'KeyW', 'Space', 'MouseLeft', 'GamepadA'. */
  key(code: string): boolean {
    return requireWorld('Input').input.key(code);
  },
  /** Raw key/button went down this frame. */
  keyPressed(code: string): boolean {
    return requireWorld('Input').input.keyPressed(code);
  },
  /** Mouse movement this frame in pixels. */
  get mouseDelta(): { x: number; y: number } {
    return requireWorld('Input').input.mouseDelta;
  },
};

/** Game time. */
export const Time = {
  /** Seconds since the previous frame (fixedDt inside fixedUpdate). */
  get dt(): number {
    return requireWorld('Time').dt;
  },
  /** Alias of dt. */
  get deltaTime(): number {
    return requireWorld('Time').dt;
  },
  /** Simulated seconds since the game started (scaled by timeScale). */
  get time(): number {
    return requireWorld('Time').time;
  },
  /** Frames since the game started. */
  get frame(): number {
    return requireWorld('Time').frame;
  },
  /** Fixed physics timestep in seconds. */
  get fixedDt(): number {
    return requireWorld('Time').fixedDt;
  },
  /** 1 = normal speed, 0 = paused, 0.5 = slow motion. */
  get timeScale(): number {
    return requireWorld('Time').timeScale;
  },
  set timeScale(v: number) {
    const w = requireWorld('Time');
    w.timeScale = Number.isFinite(v) ? Math.max(0, v) : 1;
  },
  /** Unscaled seconds since the game started. */
  get realTime(): number {
    return requireWorld('Time').realTime;
  },
};

/** Physics queries. */
export const Physics = {
  /**
   * Casts a ray; returns the first solid collider hit or null.
   * Example: `Physics.raycast(this.entity.worldPosition, [0, -1, 0], 2, { exclude: this.entity })`.
   */
  raycast(origin: Vec3Like, direction: Vec3Like, maxDistance = 100, opts?: QueryOptions): RaycastHit | null {
    return requireWorld('Physics').physics.raycast(origin, direction, maxDistance, opts);
  },
  /** Entities whose colliders overlap a sphere. */
  overlapSphere(center: Vec3Like, radius: number, opts?: QueryOptions): RuntimeEntity[] {
    return requireWorld('Physics').physics.overlapSphere(center, radius, opts);
  },
  /** World gravity (m/s^2, a copy). */
  get gravity(): Vector3 {
    return requireWorld('Physics').physics.gravity.clone();
  },
};

/** Sound. */
export const Audio = {
  /** Plays an audio file: Audio.play('audio/music.ogg', { loop: true, volume: 0.5 }). */
  play(clip: string, opts?: PlayOptions): void {
    requireWorld('Audio').playClip(clip, opts);
  },
  /** Plays a synthesized effect: 'coin', 'jump', 'hit', 'explosion', 'powerup', 'laser', 'click', 'win', 'lose'. */
  sfx(preset: SfxPreset, opts?: PlayOptions): void {
    requireWorld('Audio').playSfx(preset, opts);
  },
  stopAll(): void {
    requireWorld('Audio').stopAudio();
  },
};

/** Screen-space HUD text (UIText components and ad-hoc labels). */
export const UI = {
  /** Sets a HUD element's text (creates the element if needed): UI.text('score', `Score: ${n}`). */
  text(id: string, text: unknown, opts?: Partial<HudEntry>): void {
    requireWorld('UI').setHudText(id, text, opts);
  },
  /** Shows or hides a HUD element. */
  show(id: string, visible = true): void {
    requireWorld('UI').showHud(id, visible);
  },
  hide(id: string): void {
    requireWorld('UI').showHud(id, false);
  },
  /** Current state of a HUD element, or null. */
  get(id: string): HudEntry | null {
    return requireWorld('UI').hud[id] ?? null;
  },
};

/** Game state, events and win/lose. */
export const Game = {
  /** Plain mutable object for score, lives, flags... Game.state.score = (Game.state.score ?? 0) + 1. */
  get state(): Record<string, any> {
    return requireWorld('Game').gameState;
  },
  set state(v: Record<string, any>) {
    const s = requireWorld('Game').gameState;
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, v ?? {});
  },
  /** Sends a game event to Game.on listeners (and to the host / play-test report). */
  emit(name: string, data?: unknown): void {
    requireWorld('Game').emitGame(name, data);
  },
  /** Listens for a game event ('*' = all). Returns a function that removes the listener. */
  on(name: string, fn: (data: any, name: string) => void): () => void {
    return requireWorld('Game').onGame(name, fn);
  },
  /** Ends the game as a win. */
  win(message?: string): void {
    requireWorld('Game').win(message);
  },
  /** Ends the game as a loss. */
  lose(message?: string): void {
    requireWorld('Game').lose(message);
  },
  /** null while playing, otherwise { result: 'win' | 'lose', message }. */
  get over(): GameOver | null {
    return requireWorld('Game').gameOver;
  },
  /** Reloads the starting scene and clears Game.state (at the end of the frame). */
  restart(): void {
    requireWorld('Game').restart();
  },
};

/** Entities in the running scene. */
export const Scene = {
  /** By id, 'Parent/Child' path or name. null if missing. */
  find(ref: string): RuntimeEntity | null {
    return requireWorld('Scene').find(ref);
  },
  /** All matching entities: Scene.findAll({ tag: 'Coin' }) or Scene.findAll('Coin'). */
  findAll(query?: FindQuery | string): RuntimeEntity[] {
    return requireWorld('Scene').findAll(query);
  },
  /** Spawns a prefab or clones an entity: Scene.instantiate('prefabs/coin.prefab.json', { position: [0, 1, 0] }). */
  instantiate(prefab: string | RuntimeEntity, opts?: InstantiateOptions): RuntimeEntity {
    return requireWorld('Scene').instantiate(prefab, opts);
  },
  /** Destroys an entity at the end of the frame (or after `delay` seconds). */
  destroy(entity: RuntimeEntity | string, delay = 0): void {
    requireWorld('Scene').destroy(entity, delay);
  },
  /** Loads another scene by name or path at the end of the frame (Game.state is kept). */
  load(scene: string): void {
    requireWorld('Scene').loadScene(scene);
  },
  /** Name of the running scene. */
  get name(): string {
    return requireWorld('Scene').sceneName;
  },
};

/** Logging (shows up in the editor console and play-test reports). */
export const Debug = {
  log(...args: unknown[]): void {
    requireWorld('Debug').log('info', args);
  },
  warn(...args: unknown[]): void {
    requireWorld('Debug').log('warn', args);
  },
};

/** Seeded random numbers: the same seed gives the same game. Prefer this over Math.random(). */
export const Random = {
  /** Float in [0, 1). */
  value(): number {
    return requireWorld('Random').random.next();
  },
  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * requireWorld('Random').random.next();
  },
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    return lo + Math.floor(requireWorld('Random').random.next() * (hi - lo + 1));
  },
  /** Random element of an array (undefined if empty). */
  pick<T>(items: readonly T[]): T | undefined {
    if (!items || items.length === 0) return undefined;
    return items[Math.floor(requireWorld('Random').random.next() * items.length)];
  },
  /** True with probability p (0..1). */
  chance(p: number): boolean {
    return requireWorld('Random').random.next() < p;
  },
  /** Shuffled copy of an array. */
  shuffle<T>(items: readonly T[]): T[] {
    const rng = requireWorld('Random').random;
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  },
  /** Point inside a circle of `radius` on the XZ plane, as [x, 0, z]. */
  insideCircle(radius = 1): [number, number, number] {
    const rng = requireWorld('Random').random;
    const r = radius * Math.sqrt(rng.next());
    const a = rng.next() * Math.PI * 2;
    return [Math.cos(a) * r, 0, Math.sin(a) * r];
  },
  /** Reseeds the generator. */
  seed(seed: number): void {
    requireWorld('Random').random.seed(seed);
  },
};
