import type { SceneDoc } from '@aige/core';
import type { RuntimeEntity } from './entity.ts';
import { ScriptedInput, type ScriptedInputEvent } from './input.ts';
import { cloneJson, quatToEulerDeg, round, roundV, toPlain } from './math.ts';
import type { GameOver, HudEntry, LogEntry, ScriptError, V3 } from './types.ts';
import type { World } from './world.ts';

export interface HeadlessOptions {
  /** Seconds of game time to simulate. */
  seconds: number;
  /** Scripted input timeline (replaces the world's input source). */
  inputs?: ScriptedInputEvent[];
  /** Entity refs (id, path or name) whose position is sampled ~10x per second. */
  probes?: string[];
  /** Times (seconds) at which to capture the scene as a SceneDoc (for screenshots). */
  captureAt?: number[];
  /** Stop as soon as Game.win/lose is called (default true). */
  stopOnGameOver?: boolean;
  /** Probe samples per second (default 10). */
  sampleRate?: number;
  /** Maximum log lines / events kept (default 2000 each). */
  maxEntries?: number;
}

export interface ProbeSample {
  t: number;
  position: V3;
  grounded?: boolean;
  destroyed?: true;
}

export interface EntitySummary {
  id: string;
  name: string;
  position: V3;
  rotation: V3;
  active: boolean;
  destroyed: boolean;
  tags: string[];
  scripts: string[];
  grounded?: boolean;
  velocity?: V3;
}

export interface HeadlessError {
  message: string;
  script: string;
  entity: string | null;
  stack: string;
  hook: string;
  /** First time (seconds) it happened. */
  t: number;
  /** How many times it happened. */
  count: number;
}

export interface HeadlessResult {
  frames: number;
  simulatedSeconds: number;
  /** Wall-clock milliseconds the run took. */
  wallMs: number;
  logs: string[];
  errors: HeadlessError[];
  /** Game events (Game.emit, collect, win/lose...), scene loads and sounds ('audio:sfx', 'audio:play'). */
  events: { t: number; name: string; data: unknown }[];
  probes: Record<string, ProbeSample[]>;
  final: {
    gameState: Record<string, unknown>;
    hud: Record<string, HudEntry>;
    over: GameOver | null;
    entities: Record<string, EntitySummary | null>;
    counts: { entities: number; spawned: number; destroyed: number };
  };
  stateHash: string;
  captures: { t: number; scene: SceneDoc }[];
}

function summarize(e: RuntimeEntity): EntitySummary {
  const s: EntitySummary = {
    id: e.id,
    name: e.name,
    position: roundV(e.worldPosition, 3),
    rotation: quatToEulerDeg(e.worldQuaternion).map((n) => round(n, 1)) as V3,
    active: e.active,
    destroyed: e.destroyed,
    tags: [...e.tags],
    scripts: e.scripts.map((b) => b.script),
  };
  if (e.character) {
    s.grounded = e.character.grounded;
    s.velocity = roundV(e.character.velocity, 3);
  } else if (e.body && e.body.kind === 'dynamic') {
    s.velocity = roundV(e.body.velocity, 3);
  }
  return s;
}

/**
 * Runs a world headless for `seconds` of game time at the fixed timestep and reports what happened:
 * logs, script errors (deduplicated, never fatal), game events, probe samples, final state and scene
 * captures. Deterministic for the same world, inputs and seed.
 */
export function runHeadless(world: World, opts: HeadlessOptions): HeadlessResult {
  const started = performance.now();
  const max = opts.maxEntries ?? 2000;
  const logs: string[] = [];
  let droppedLogs = 0;
  const errors = new Map<string, HeadlessError>();
  const events: HeadlessResult['events'] = [];
  let droppedEvents = 0;
  let spawned = 0;
  let destroyed = 0;
  const pushEvent = (t: number, name: string, data: unknown) => {
    if (events.length < max) events.push({ t, name, data });
    else droppedEvents++;
  };
  const onLog = (l: LogEntry) => {
    if (logs.length >= max) {
      droppedLogs++;
      return;
    }
    const who = l.entity ? `${l.entity}${l.script ? ` (${l.script})` : ''}: ` : '';
    logs.push(`[${l.t.toFixed(2)}s] ${l.level === 'warn' ? 'warn: ' : ''}${who}${l.message}`);
  };
  const onError = (e: ScriptError) => {
    const key = `${e.script}|${e.entityId}|${e.hook}|${e.message}`;
    const prev = errors.get(key);
    if (prev) prev.count++;
    else
      errors.set(key, {
        message: e.message,
        script: e.script,
        entity: e.entity,
        stack: e.stack,
        hook: e.hook,
        t: e.t,
        count: 1,
      });
  };
  // Problems found while the world was created (missing scripts, awake/start errors...).
  if (world.frame === 0) {
    for (const l of world.startup.logs) onLog(l);
    for (const e of world.startup.errors) onError(e);
  }
  const off = [
    world.on('log', onLog),
    world.on('error', onError),
    world.on('game', (g) => pushEvent(g.t, g.name, g.data)),
    world.on('sceneLoad', (s) =>
      pushEvent(s.t, s.restart ? 'restart' : 'sceneLoad', { name: s.name, path: s.path }),
    ),
    world.on('audio', (a) => pushEvent(a.t, `audio:${a.kind}`, { name: a.name })),
    world.on('spawned', () => spawned++),
    world.on('destroyed', () => destroyed++),
  ];

  if (opts.inputs) world.setInput(new ScriptedInput(opts.inputs));

  const probeRefs = [...new Set(opts.probes ?? [])];
  const probes: Record<string, ProbeSample[]> = {};
  const probeEntities = new Map<string, RuntimeEntity | null>();
  const probeDone = new Set<string>();
  for (const ref of probeRefs) probes[ref] = [];
  const sample = (t: number) => {
    for (const ref of probeRefs) {
      if (probeDone.has(ref)) continue;
      let e = probeEntities.get(ref) ?? null;
      if (!e) {
        e = world.find(ref, { quiet: true });
        if (e) probeEntities.set(ref, e);
      }
      if (!e) continue;
      const list = probes[ref]!;
      if (e.destroyed) {
        const last = list[list.length - 1];
        list.push({ t: round(t, 3), position: last?.position ?? [0, 0, 0], destroyed: true });
        probeDone.add(ref);
        continue;
      }
      const s: ProbeSample = { t: round(t, 3), position: roundV(e.worldPosition, 3) };
      if (e.character) s.grounded = e.character.grounded;
      list.push(s);
    }
  };

  const captureTimes = [...(opts.captureAt ?? [])].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const captures: HeadlessResult['captures'] = [];
  let capIdx = 0;
  const capture = (t: number) => {
    while (capIdx < captureTimes.length && captureTimes[capIdx]! <= t + 1e-9) {
      capIdx++;
      try {
        captures.push({ t: round(t, 3), scene: world.snapshotScene() });
      } catch {
        // never fail the run because of a snapshot
      }
    }
  };

  const dt = world.fixedDt;
  const seconds = Math.max(0, Number.isFinite(opts.seconds) ? opts.seconds : 0);
  const maxFrames = Math.ceil(seconds / dt - 1e-6);
  const rate = Math.max(0.1, opts.sampleRate ?? 10);
  const interval = 1 / rate;
  let nextSample = interval;
  const stopOnGameOver = opts.stopOnGameOver !== false;
  let frames = 0;
  const startReal = world.realTime;

  sample(world.realTime - startReal);
  capture(0);
  for (let i = 0; i < maxFrames; i++) {
    if (stopOnGameOver && world.gameOver) break;
    world.update(dt);
    frames++;
    const t = world.realTime - startReal;
    while (t + 1e-9 >= nextSample) {
      sample(t);
      nextSample += interval;
    }
    capture(t);
  }

  for (const f of off) f();
  if (droppedLogs) logs.push(`... ${droppedLogs} more log lines dropped`);
  if (droppedEvents) pushEvent(round(world.time, 3), 'eventsDropped', { count: droppedEvents });

  const finalEntities: Record<string, EntitySummary | null> = {};
  for (const ref of probeRefs) {
    const e = probeEntities.get(ref) ?? world.find(ref, { quiet: true });
    finalEntities[ref] = e ? summarize(e) : null;
    if (!e) logs.push(`warn: probe '${ref}' matched no entity (use an id, 'Parent/Child' path or name).`);
  }

  return {
    frames,
    simulatedSeconds: round(world.time, 4),
    wallMs: Math.round(performance.now() - started),
    logs,
    errors: [...errors.values()],
    events,
    probes,
    final: {
      gameState: toPlain(world.gameState) as Record<string, unknown>,
      hud: cloneJson(world.hud),
      over: world.gameOver ? { ...world.gameOver } : null,
      entities: finalEntities,
      counts: { entities: world.findAll().length, spawned, destroyed },
    },
    stateHash: world.stateHash(),
    captures,
  };
}
