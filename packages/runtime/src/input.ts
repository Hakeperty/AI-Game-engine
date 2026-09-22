import { didYouMean, type InputMap } from '@aige/core';

/**
 * A source of raw input. Codes are KeyboardEvent.code values ('KeyW', 'Space', 'ShiftLeft', 'ArrowUp'),
 * mouse buttons ('MouseLeft', 'MouseRight', 'MouseMiddle') and gamepad buttons ('GamepadA', 'GamepadB',
 * 'GamepadX', 'GamepadY', 'GamepadLB', 'GamepadRB', 'GamepadLT', 'GamepadRT', 'GamepadBack',
 * 'GamepadStart', 'GamepadUp', 'GamepadDown', 'GamepadLeft', 'GamepadRight').
 */
export interface InputSource {
  /** Called once at the start of every frame with the unscaled game time (seconds) and frame number. */
  poll(time: number, frame: number): void;
  /** Is a key / button code held? */
  isKeyDown(code: string): boolean;
  /** Direct action state (scripted input), or undefined to derive it from the project's key bindings. */
  actionDown?(action: string): boolean | undefined;
  /** Direct axis value in -1..1 (scripted input, gamepad sticks), or undefined to derive it from keys. */
  axisValue?(axis: string): number | undefined;
  /** Mouse movement since the previous frame, in pixels. */
  mouseDelta?(): { x: number; y: number };
  dispose?(): void;
}

/** Input that never presses anything. */
export class NullInput implements InputSource {
  poll(): void {}
  isKeyDown(): boolean {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Scripted input (headless play-tests)
// ---------------------------------------------------------------------------------------------

export interface ScriptedInputEvent {
  /** Time in seconds (unscaled game time). */
  at: number;
  /** Action name from project.input.actions ('jump') or a raw key code ('Space'). */
  action?: string;
  /** Raw key code ('KeyW'). Same as `action` with a key code. */
  key?: string;
  /** Axis name from project.input.axes ('move_x', 'move_y'). */
  axis?: string;
  /** Axis value -1..1 (default 1). */
  value?: number;
  /**
   * press: held until a matching release. release: let go (axis: back to 0). tap: held for exactly one frame.
   * hold: held for `duration` seconds. Axis events keep their value until changed (hold/tap reset it after).
   * Default: 'tap' for actions, 'press' for axes.
   */
  type?: 'press' | 'release' | 'tap' | 'hold';
  /** For 'hold' (seconds, default 0.5). */
  duration?: number;
}

/** Plays back a timeline of input events. Deterministic: frames, not wall-clock time. */
export class ScriptedInput implements InputSource {
  private readonly events: ScriptedInputEvent[];
  private index = 0;
  /** Held names (actions or key codes) -> release time (Infinity = until released, NaN = tap). */
  private readonly held = new Map<string, number>();
  private readonly taps = new Map<string, number>();
  private readonly axes = new Map<string, { value: number; until: number; tapFrame: number | null }>();
  private frame = 0;

  constructor(events: ScriptedInputEvent[] = []) {
    this.events = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e && typeof e.at === 'number' && Number.isFinite(e.at))
      .sort((a, b) => a.e.at - b.e.at || a.i - b.i)
      .map(({ e }) => e);
  }

  /** Every action/key/axis name the timeline mentions. */
  names(): string[] {
    const s = new Set<string>();
    for (const e of this.events) {
      const n = e.action ?? e.key ?? e.axis;
      if (n) s.add(n);
    }
    return [...s];
  }

  poll(time: number, frame: number): void {
    this.frame = frame;
    // expire taps from earlier frames and finished holds
    for (const [name, f] of this.taps) if (f < frame) this.taps.delete(name);
    for (const [name, until] of this.held) if (time >= until - 1e-9) this.held.delete(name);
    for (const [name, a] of this.axes) {
      if ((a.tapFrame !== null && a.tapFrame < frame) || time >= a.until - 1e-9) this.axes.delete(name);
    }
    const eps = 1e-9;
    while (this.index < this.events.length && this.events[this.index]!.at <= time + eps) {
      this.apply(this.events[this.index++]!, time, frame);
    }
  }

  private apply(e: ScriptedInputEvent, time: number, frame: number): void {
    if (e.axis) {
      const type = e.type ?? 'press';
      const value = Math.max(-1, Math.min(1, typeof e.value === 'number' ? e.value : 1));
      if (type === 'release') this.axes.delete(e.axis);
      else if (type === 'tap')
        this.axes.set(e.axis, { value, until: Number.POSITIVE_INFINITY, tapFrame: frame });
      else if (type === 'hold')
        this.axes.set(e.axis, { value, until: e.at + Math.max(0, e.duration ?? 0.5), tapFrame: null });
      else this.axes.set(e.axis, { value, until: Number.POSITIVE_INFINITY, tapFrame: null });
      return;
    }
    const name = e.action ?? e.key;
    if (!name) return;
    const type = e.type ?? 'tap';
    if (type === 'release') {
      this.held.delete(name);
      this.taps.delete(name);
    } else if (type === 'tap') this.taps.set(name, frame);
    else if (type === 'hold') {
      const until = e.at + Math.max(0, e.duration ?? 0.5);
      if (until > time) this.held.set(name, until);
      else this.taps.set(name, frame); // zero-length hold: at least one frame
    } else this.held.set(name, Number.POSITIVE_INFINITY);
  }

  private down(name: string): boolean {
    return this.held.has(name) || this.taps.get(name) === this.frame;
  }

  isKeyDown(code: string): boolean {
    return this.down(code);
  }

  actionDown(action: string): boolean | undefined {
    return this.down(action) ? true : undefined;
  }

  axisValue(axis: string): number | undefined {
    return this.axes.get(axis)?.value;
  }
}

// ---------------------------------------------------------------------------------------------
// Input state (edge detection + bindings), owned by the World
// ---------------------------------------------------------------------------------------------

/** Resolves actions/axes through the project's InputMap and tracks pressed/released edges per frame. */
export class InputState {
  source: InputSource;
  private readonly map: InputMap;
  private readonly now = new Map<string, boolean>();
  private readonly prev = new Map<string, boolean>();
  private readonly keyNow = new Map<string, boolean>();
  private readonly keyPrev = new Map<string, boolean>();
  private mouse = { x: 0, y: 0 };
  private readonly warn: (key: string, message: string) => void;

  constructor(map: InputMap, source: InputSource, warn: (key: string, message: string) => void) {
    this.map = map;
    this.source = source;
    this.warn = warn;
    for (const a of Object.keys(map.actions ?? {})) this.now.set(a, false);
    if (source instanceof ScriptedInput)
      for (const n of source.names()) if (!this.now.has(n)) this.now.set(n, false);
  }

  setSource(source: InputSource): void {
    this.source.dispose?.();
    this.source = source;
    if (source instanceof ScriptedInput)
      for (const n of source.names()) if (!this.now.has(n)) this.now.set(n, false);
  }

  /** Polls the source and updates edges. Called by the World at the start of every frame. */
  beginFrame(time: number, frame: number): void {
    this.source.poll(time, frame);
    for (const [name, v] of this.now) {
      this.prev.set(name, v);
      this.now.set(name, this.computeAction(name));
    }
    for (const [code, v] of this.keyNow) {
      this.keyPrev.set(code, v);
      this.keyNow.set(code, this.source.isKeyDown(code));
    }
    const md = this.source.mouseDelta?.();
    this.mouse = md ? { x: md.x, y: md.y } : { x: 0, y: 0 };
  }

  private computeAction(name: string): boolean {
    if (this.source.actionDown?.(name)) return true;
    const keys = this.map.actions?.[name];
    if (keys) for (const k of keys) if (this.source.isKeyDown(k)) return true;
    return false;
  }

  private track(name: string): boolean {
    let v = this.now.get(name);
    if (v === undefined) {
      if (!this.map.actions?.[name] && !this.isKeyCode(name)) {
        this.warn(
          `input-action:${name}`,
          `Unknown input action '${name}'. ${didYouMean(name, Object.keys(this.map.actions ?? {})) ?? ''} Actions: ${Object.keys(
            this.map.actions ?? {},
          ).join(', ')} (add it to project.input.actions).`.replace(/\s+/g, ' '),
        );
      }
      v = this.computeAction(name);
      this.now.set(name, v);
      this.prev.set(name, false);
    }
    return v;
  }

  private isKeyCode(name: string): boolean {
    return /^(Key[A-Z]|Digit\d|Arrow|Space|Shift|Control|Alt|Enter|Escape|Tab|Backspace|Mouse|Gamepad|F\d)/.test(
      name,
    );
  }

  held(action: string): boolean {
    return this.track(action);
  }
  pressed(action: string): boolean {
    return this.track(action) && !this.prev.get(action);
  }
  released(action: string): boolean {
    return !this.track(action) && !!this.prev.get(action);
  }

  key(code: string): boolean {
    let v = this.keyNow.get(code);
    if (v === undefined) {
      v = this.source.isKeyDown(code);
      this.keyNow.set(code, v);
      this.keyPrev.set(code, false);
    }
    return v;
  }
  keyPressed(code: string): boolean {
    return this.key(code) && !this.keyPrev.get(code);
  }

  axis(name: string): number {
    const direct = this.source.axisValue?.(name);
    if (typeof direct === 'number' && direct !== 0) return Math.max(-1, Math.min(1, direct));
    const def = this.map.axes?.[name];
    if (!def) {
      if (direct === undefined) {
        this.warn(
          `input-axis:${name}`,
          `Unknown input axis '${name}'. ${didYouMean(name, Object.keys(this.map.axes ?? {})) ?? ''} Axes: ${Object.keys(
            this.map.axes ?? {},
          ).join(', ')} (add it to project.input.axes).`.replace(/\s+/g, ' '),
        );
      }
      return 0;
    }
    let v = 0;
    for (const k of def.positive ?? []) if (this.source.isKeyDown(k)) v += 1;
    for (const k of def.negative ?? []) if (this.source.isKeyDown(k)) v -= 1;
    return Math.max(-1, Math.min(1, v));
  }

  get mouseDelta(): { x: number; y: number } {
    return { ...this.mouse };
  }
}

// ---------------------------------------------------------------------------------------------
// DOM input (browser)
// ---------------------------------------------------------------------------------------------

const PAD_BUTTONS = [
  'GamepadA',
  'GamepadB',
  'GamepadX',
  'GamepadY',
  'GamepadLB',
  'GamepadRB',
  'GamepadLT',
  'GamepadRT',
  'GamepadBack',
  'GamepadStart',
  'GamepadLS',
  'GamepadRS',
  'GamepadUp',
  'GamepadDown',
  'GamepadLeft',
  'GamepadRight',
];
const MOUSE_BUTTONS = ['MouseLeft', 'MouseMiddle', 'MouseRight'];

export interface DomInputOptions {
  /** Element that receives mouse input (default: window). Keyboard is read from window. */
  target?: HTMLElement | Window;
  /** Stick dead zone (default 0.15). */
  deadZone?: number;
  /** Request pointer lock on click (for mouse-look games). Default false. */
  pointerLock?: boolean;
}

/**
 * Keyboard, mouse and gamepad input for the browser. Touches the DOM only when constructed.
 * Gamepad left stick drives 'move_x'/'move_y', right stick 'look_x'/'look_y'.
 */
export class DomInput implements InputSource {
  private readonly keys = new Set<string>();
  private readonly padKeys = new Set<string>();
  private readonly padAxes = new Map<string, number>();
  private dx = 0;
  private dy = 0;
  private frameDelta = { x: 0, y: 0 };
  private readonly target: HTMLElement | Window;
  private readonly deadZone: number;
  private readonly off: (() => void)[] = [];

  constructor(opts: DomInputOptions = {}) {
    this.target = opts.target ?? window;
    this.deadZone = opts.deadZone ?? 0.15;
    const on = <K extends string>(
      t: EventTarget,
      type: K,
      fn: (e: any) => void,
      o?: AddEventListenerOptions,
    ) => {
      t.addEventListener(type, fn, o);
      this.off.push(() => t.removeEventListener(type, fn, o));
    };
    const isTyping = (e: Event) => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    on(window, 'keydown', (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    on(window, 'blur', () => this.keys.clear());
    on(this.target, 'mousedown', (e: MouseEvent) => {
      const b = MOUSE_BUTTONS[e.button];
      if (b) this.keys.add(b);
      if (opts.pointerLock && this.target !== window) (this.target as HTMLElement).requestPointerLock?.();
    });
    on(window, 'mouseup', (e: MouseEvent) => {
      const b = MOUSE_BUTTONS[e.button];
      if (b) this.keys.delete(b);
    });
    on(window, 'mousemove', (e: MouseEvent) => {
      this.dx += e.movementX ?? 0;
      this.dy += e.movementY ?? 0;
    });
    on(this.target, 'contextmenu', (e: Event) => e.preventDefault());
  }

  poll(): void {
    this.frameDelta = { x: this.dx, y: this.dy };
    this.dx = 0;
    this.dy = 0;
    this.padKeys.clear();
    this.padAxes.clear();
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad?.connected) continue;
      pad.buttons.forEach((b, i) => {
        const name = PAD_BUTTONS[i];
        if (name && (b.pressed || b.value > 0.5)) this.padKeys.add(name);
      });
      const dz = (v: number | undefined) => (v === undefined || Math.abs(v) < this.deadZone ? 0 : v);
      const add = (axis: string, v: number) => {
        if (v !== 0 && !this.padAxes.has(axis)) this.padAxes.set(axis, v);
      };
      add('move_x', dz(pad.axes[0]));
      add('move_y', -dz(pad.axes[1]));
      add('look_x', dz(pad.axes[2]));
      add('look_y', -dz(pad.axes[3]));
    }
  }

  isKeyDown(code: string): boolean {
    return this.keys.has(code) || this.padKeys.has(code);
  }

  axisValue(axis: string): number | undefined {
    return this.padAxes.get(axis);
  }

  mouseDelta(): { x: number; y: number } {
    return this.frameDelta;
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
    this.keys.clear();
  }
}
