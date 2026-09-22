import { Worker } from 'node:worker_threads';
import {
  AigeError,
  type PrefabDoc,
  type ProjectDoc,
  type SceneDoc,
  getScene,
  resolveScenePath,
} from '@aige/core';
import type { HeadlessOptions, HeadlessResult } from '@aige/runtime';
import type { ProjectHost } from './host.ts';
import { type CompiledModule, compileUserModule } from './sandbox.ts';

export const RUNTIME_GLOBAL = '__aigeRuntime';

export interface ModelInfoLite {
  bounds: { min: number[]; max: number[]; size: number[]; center: number[] };
  collider: unknown;
}

/** Everything a play-test needs, as plain JSON (sent to a worker thread). */
export interface PlayPayload {
  project: ProjectDoc;
  scene: SceneDoc;
  scenePath: string;
  scenes: Record<string, SceneDoc>;
  prefabs: Record<string, PrefabDoc>;
  scripts: Record<string, CompiledModule>;
  /** entity id (active scene) -> model info */
  models: Record<string, ModelInfoLite>;
  /** model path -> model info (default params), for prefabs and other scenes */
  modelsByPath: Record<string, ModelInfoLite>;
  options: HeadlessOptions;
  seed: number;
}

/** Collects scene data, compiles scripts and builds model infos for a play-test. */
export async function preparePlay(host: ProjectHost, opts: { scene?: string; options: HeadlessOptions; seed?: number }): Promise<{ payload: PlayPayload; warnings: string[] }> {
  const state = host.state;
  const scenePath = resolveScenePath(state, opts.scene);
  const scene = getScene(state, scenePath);
  const warnings: string[] = [];
  const allEntities = [
    ...Object.values(state.scenes).flatMap((s) => s.entities),
    ...Object.values(state.prefabs).flatMap((p) => p.entities),
  ];
  const scriptPaths = new Set<string>();
  const modelRefs = new Map<string, Record<string, unknown>>();
  for (const e of allEntities) {
    for (const c of e.components) {
      if (c.type === 'Script' && typeof c.script === 'string' && !c.script.startsWith('builtin:')) scriptPaths.add(c.script);
      if (c.type === 'MeshRenderer' && typeof c.model === 'string') modelRefs.set(c.model, {});
    }
  }
  const scripts: Record<string, CompiledModule> = {};
  for (const path of scriptPaths) {
    if (!(await host.fs.exists(path))) {
      warnings.push(`Script '${path}' does not exist.`);
      continue;
    }
    scripts[path] = await compileUserModule({ entry: host.fs.abs(path), root: host.root, virtuals: { aige: RUNTIME_GLOBAL } });
  }
  const lite = (info: { bounds: ModelInfoLite['bounds']; collider: unknown }): ModelInfoLite => ({ bounds: info.bounds, collider: info.collider });
  const modelsByPath: Record<string, ModelInfoLite> = {};
  for (const path of modelRefs.keys()) {
    try {
      modelsByPath[path] = lite((await host.assets.build(path, {})).info);
    } catch (err) {
      warnings.push(`Model '${path}' failed to build: ${(err as Error).message}`);
    }
  }
  const models: Record<string, ModelInfoLite> = {};
  for (const e of scene.entities) {
    const mr = e.components.find((c) => c.type === 'MeshRenderer');
    if (!mr?.model) continue;
    const params = (mr.params as Record<string, unknown>) ?? {};
    if (Object.keys(params).length === 0) {
      if (modelsByPath[mr.model as string]) models[e.id] = modelsByPath[mr.model as string]!;
      continue;
    }
    try {
      models[e.id] = lite((await host.assets.build(mr.model as string, params)).info);
    } catch (err) {
      warnings.push(`${e.id} ${e.name}: model failed to build: ${(err as Error).message}`);
    }
  }
  return {
    payload: {
      project: state.project,
      scene,
      scenePath,
      scenes: state.scenes,
      prefabs: state.prefabs,
      scripts,
      models,
      modelsByPath,
      options: opts.options,
      seed: opts.seed ?? 1,
    },
    warnings,
  };
}

/**
 * Runs a play-test in a worker thread so a runaway script (infinite loop in update) can be killed.
 * Falls back to running in-process where workers can't load TypeScript (e.g. bundled apps).
 */
export async function runPlayTest(payload: PlayPayload, opts: { timeoutMs?: number; inProcess?: boolean } = {}): Promise<HeadlessResult> {
  const timeoutMs = opts.timeoutMs ?? Math.max(20_000, payload.options.seconds * 1500 + 15_000);
  if (opts.inProcess || process.env.AIGE_INPROCESS_PLAY === '1') {
    const { executePlay } = await import('./play-exec.ts');
    return executePlay(payload);
  }
  let worker: Worker;
  try {
    worker = new Worker(new URL('./play-worker.ts', import.meta.url), { workerData: payload });
  } catch {
    const { executePlay } = await import('./play-exec.ts');
    return executePlay(payload);
  }
  return new Promise<HeadlessResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(
        new AigeError('TIMEOUT', `The game did not finish ${payload.options.seconds}s of simulation within ${Math.round(timeoutMs / 1000)}s.`, {
          hint: 'A script probably has an infinite loop (e.g. a while loop in update). Check recently written scripts.',
        }),
      );
    }, timeoutMs);
    worker.once('message', (msg: { ok: true; result: HeadlessResult } | { ok: false; error: { message: string; code?: string } }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (msg.ok) resolve(msg.result);
      else reject(new AigeError('SCRIPT_ERROR', `Play-test failed: ${msg.error.message}`));
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(new AigeError('INTERNAL', `Play-test worker crashed: ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------------------------

import { defineCommand } from '@aige/core';
import { z } from 'zod';

const InputEvent = z
  .object({
    at: z.number().min(0).describe('Seconds'),
    action: z.string().optional().describe("Action ('jump', 'fire') or key code ('Space')"),
    axis: z.string().optional().describe("'move_x' (right +1) or 'move_y' (forward +1)"),
    key: z.string().optional(),
    value: z.number().min(-1).max(1).optional(),
    type: z.enum(['press', 'release', 'tap', 'hold']).optional(),
    duration: z.number().positive().optional(),
  })
  .strict();

type Services = { host: ProjectHost };

export const gameRunHeadless = defineCommand({
  name: 'game_run_headless',
  group: 'verify',
  kind: 'action',
  tier: 'core',
  description: `Play-test the game without a window: simulate N seconds with scripted input and report what happened.
Returns: whether the game was won or lost, Game.state (e.g. score), HUD texts, script errors (with file:line), logs, game events (collect, win...), positions of probed entities over time, and optional screenshots of the running game.
Use it after every gameplay change to prove the game works: walk the player to the coins and the goal with inputs.
Axes: move_y +1 = forward (away from the camera, toward -Z); move_x +1 = right. Actions: jump, fire, interact, sprint.
Example: {"seconds":8,"inputs":[{"at":0,"axis":"move_y","value":1},{"at":1.5,"action":"jump"},{"at":4,"axis":"move_y","value":0}],"probes":["Player"],"screenshotsAt":[2]}`,
  input: z
    .object({
      scene: z.string().optional(),
      seconds: z.number().positive().max(120).default(10),
      inputs: z.array(InputEvent).max(500).default([]),
      probes: z.array(z.string()).max(10).optional().describe("Entities to track (default: the entity tagged 'Player')"),
      screenshotsAt: z.array(z.number().min(0)).max(4).default([]).describe('Times (s) to capture game-camera screenshots'),
      stopOnGameOver: z.boolean().default(true),
      seed: z.number().int().default(1),
    })
    .strict(),
  async run(ctx, input) {
    const host = (ctx.services as Services).host;
    const scene = getScene(ctx.state, input.scene);
    const probes =
      input.probes ??
      scene.entities.filter((e) => e.tags.includes('Player')).map((e) => e.id).slice(0, 1);
    const { payload, warnings } = await preparePlay(host, {
      ...(input.scene ? { scene: input.scene } : {}),
      seed: input.seed,
      options: {
        seconds: input.seconds,
        inputs: input.inputs,
        probes,
        captureAt: input.screenshotsAt,
        stopOnGameOver: input.stopOnGameOver,
        sampleRate: 4,
      },
    });
    const result = await runPlayTest(payload);
    // Screenshots of captured frames.
    const images = [];
    for (const cap of result.captures) {
      try {
        const { image } = await host.render.screenshot({ sceneDoc: cap.scene, views: [{ kind: 'camera', label: `t = ${cap.t.toFixed(1)}s` }], width: 800, height: 450, labels: false, name: `play-${cap.t.toFixed(1)}s` });
        images.push(image);
      } catch (err) {
        warnings.push(`Screenshot at ${cap.t}s failed: ${(err as Error).message}`);
      }
    }
    const eventCounts: Record<string, number> = {};
    for (const e of result.events) eventCounts[e.name] = (eventCounts[e.name] ?? 0) + 1;
    const probeTracks = Object.fromEntries(
      Object.entries(result.probes).map(([ref, samples]) => [
        ref,
        samples.filter((_, i) => i % 2 === 0).map((s) => `${s.t.toFixed(1)}s:${s.position.map((n) => n.toFixed(2)).join(',')}${s.grounded === false ? ' air' : ''}${s.destroyed ? ' destroyed' : ''}`),
      ]),
    );
    return {
      simulatedSeconds: Number(result.simulatedSeconds.toFixed(2)),
      over: result.final.over,
      gameState: result.final.gameState,
      hud: Object.fromEntries(Object.entries(result.final.hud).map(([id, h]) => [id, h.text])),
      errors: result.errors.slice(0, 10).map((e) => `${e.script}${e.entity ? ` on ${e.entity}` : ''}${e.hook ? ` (${e.hook})` : ''}: ${e.message}${e.count > 1 ? ` ×${e.count}` : ''}${e.stack ? `\n    ${e.stack.split('\n')[0]}` : ''}`),
      events: { counts: eventCounts, first: result.events.slice(0, 15).map((e) => `${e.t.toFixed(2)}s ${e.name}${e.data !== undefined && e.data !== null ? ` ${JSON.stringify(e.data).slice(0, 80)}` : ''}`) },
      logs: result.logs.slice(-25),
      probes: probeTracks,
      entities: result.final.entities,
      counts: result.final.counts,
      stateHash: result.stateHash,
      ...(warnings.length ? { warnings } : {}),
      ...(images.length ? { images } : {}),
    };
  },
});
