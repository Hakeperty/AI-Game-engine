import { api, type BehaviourClass, type HeadlessResult, NullAudio, runHeadless, World } from '@aige/runtime';
import type { ModelInfoLite, PlayPayload } from './play.ts';
import { RUNTIME_GLOBAL } from './play.ts';
import { runModule, toScriptError } from './sandbox.ts';

/** Evaluates the compiled scripts in sandboxes, builds a World and runs the headless simulation. */
export async function executePlay(payload: PlayPayload): Promise<HeadlessResult> {
  const scripts: Record<string, BehaviourClass> = {};
  const loadErrors: { message: string; script: string }[] = [];
  for (const [path, mod] of Object.entries(payload.scripts)) {
    try {
      const { exports } = runModule(mod, { filename: path, globals: { [RUNTIME_GLOBAL]: api } });
      const cls = exports.default ?? exports;
      if (typeof cls !== 'function') {
        loadErrors.push({
          script: path,
          message: `${path} must \`export default class ... extends Behaviour\`.`,
        });
        continue;
      }
      scripts[path] = cls as BehaviourClass;
    } catch (err) {
      loadErrors.push({ script: path, message: (err as Error).message });
    }
  }
  const world = await World.create({
    project: payload.project,
    scene: payload.scene,
    scenePath: payload.scenePath,
    scenes: payload.scenes,
    prefabs: payload.prefabs,
    scripts,
    models: payload.models as Record<string, never>,
    modelInfoForPath: (p: string) => payload.modelsByPath[p] as ModelInfoLite as never,
    audio: new NullAudio(),
    seed: payload.seed,
    formatError: (error: unknown, script: string) => {
      const mod = payload.scripts[script];
      if (!mod)
        return {
          message:
            error instanceof Error
              ? error.message
              : String((error as { message?: string })?.message ?? error),
        };
      const e = toScriptError(error, mod, script);
      const stack = (e.details as { stack?: string[] } | undefined)?.stack;
      return { message: e.message, ...(stack?.length ? { stack: stack.join('\n') } : {}) };
    },
  });
  try {
    const result = runHeadless(world, payload.options);
    for (const le of loadErrors) {
      result.errors.unshift({
        message: le.message,
        script: le.script,
        entity: '',
        hook: 'load',
        stack: '',
        t: 0,
        count: 1,
      } as never);
    }
    return JSON.parse(JSON.stringify(result)) as HeadlessResult;
  } finally {
    world.dispose();
  }
}
