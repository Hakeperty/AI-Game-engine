import { z } from 'zod';
import { AigeError, toErrorInfo } from '../errors.ts';
import type { CommandBus } from './bus.ts';
import { defineCommand } from './define.ts';

/** Services every bus provides so history commands can reach the bus itself. */
export interface BusServices {
  bus: CommandBus<any>;
}

export const undo = defineCommand({
  name: 'undo',
  group: 'history',
  kind: 'mutation',
  tier: 'core',
  skipHistory: true,
  description: 'Undo the last change(s). An AI turn in the editor counts as one step. Example: {"steps":1}',
  input: z.object({ steps: z.number().int().min(1).max(100).default(1) }).strict(),
  async run(ctx, input) {
    const bus = (ctx.services as BusServices).bus;
    const undone: string[] = [];
    for (let i = 0; i < input.steps; i++) {
      const label = await bus.undoInternal();
      if (!label) break;
      undone.push(label);
    }
    return { undone, remaining: bus.historyInfo().undo.length };
  },
});

export const redo = defineCommand({
  name: 'redo',
  group: 'history',
  kind: 'mutation',
  tier: 'extended',
  skipHistory: true,
  description: 'Redo changes that were undone. Example: {"steps":1}',
  input: z.object({ steps: z.number().int().min(1).max(100).default(1) }).strict(),
  async run(ctx, input) {
    const bus = (ctx.services as BusServices).bus;
    const redone: string[] = [];
    for (let i = 0; i < input.steps; i++) {
      const label = await bus.redoInternal();
      if (!label) break;
      redone.push(label);
    }
    return { redone };
  },
});

export const history = defineCommand({
  name: 'history',
  group: 'history',
  kind: 'query',
  tier: 'extended',
  description: 'List the undo and redo stacks (newest first).',
  input: z.object({ limit: z.number().int().min(1).max(300).default(20) }).strict(),
  run(ctx, input) {
    const info = (ctx.services as BusServices).bus.historyInfo();
    return { undo: info.undo.slice(0, input.limit), redo: info.redo.slice(0, input.limit) };
  },
});

const REF_RE = /^\$(\d+)((?:\.[\w-]+|\[\d+\])*)$/;

/** Replaces "$0.id" / "$2.created[0].id" strings with values from earlier batch results. */
function resolveRefs(value: unknown, results: unknown[]): unknown {
  if (typeof value === 'string') {
    const m = value.match(REF_RE);
    if (!m) return value;
    const idx = Number(m[1]);
    if (idx >= results.length) {
      throw new AigeError(
        'INVALID_INPUT',
        `Reference '${value}' points to step ${idx}, which has not run yet.`,
      );
    }
    let cur: any = results[idx];
    const path = m[2]!.match(/[\w-]+|\d+/g) ?? [];
    for (const key of path) {
      if (cur == null) break;
      cur = cur[key];
    }
    if (cur === undefined) throw new AigeError('INVALID_INPUT', `Reference '${value}' resolved to nothing.`);
    return cur;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, results));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, results)]));
  }
  return value;
}

export const batch = defineCommand({
  name: 'batch',
  group: 'history',
  kind: 'mutation',
  tier: 'core',
  description: `Run several tools in one call and one undo step. Later steps can use results of earlier ones with "$<step>.<field>" strings (e.g. "$0.id" is the id returned by step 0). With stopOnError (default) the whole batch is rolled back if any step fails. Only scene/material/prefab/query tools are allowed (no render/run/export).
Example: {"commands":[{"tool":"entity_create","input":{"name":"Tower"}},{"tool":"entity_create","input":{"name":"Top","parent":"$0.id","position":[0,5,0]}}]}`,
  input: z
    .object({
      commands: z
        .array(z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()).default({}) }).strict())
        .min(1)
        .max(500),
      stopOnError: z.boolean().default(true),
    })
    .strict(),
  async run(ctx, input) {
    const bus = (ctx.services as BusServices).bus;
    const results: unknown[] = [];
    const report: { tool: string; ok: boolean; result?: unknown; error?: unknown }[] = [];
    for (const [i, step] of input.commands.entries()) {
      const cmd = bus.get(step.tool);
      if (cmd.kind === 'action' || cmd.name === 'batch' || cmd.name === 'undo' || cmd.name === 'redo') {
        throw new AigeError('INVALID_INPUT', `Step ${i}: '${step.tool}' cannot run inside a batch.`, {
          hint: 'Call render/run/export tools and undo/redo directly.',
        });
      }
      try {
        const resolved = resolveRefs(step.input, results);
        const result = await ctx.call(step.tool, resolved);
        results.push(result);
        report.push({ tool: step.tool, ok: true, result });
      } catch (err) {
        const info = toErrorInfo(err);
        if (input.stopOnError) {
          throw new AigeError(
            info.code,
            `Batch step ${i} (${step.tool}) failed: ${info.message}. Nothing was applied.`,
            {
              ...(info.hint ? { hint: info.hint } : {}),
              details: { failedStep: i, completedSteps: i },
            },
          );
        }
        results.push(undefined);
        report.push({ tool: step.tool, ok: false, error: info });
      }
    }
    return { steps: report.length, failed: report.filter((r) => !r.ok).length, results: report };
  },
});

export const historyCommands = [undo, redo, history, batch];
