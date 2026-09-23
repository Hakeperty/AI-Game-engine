import { api, type BehaviourClass } from '@aige/runtime';
import type { CompiledScript } from '../../shared/protocol.ts';
import { host } from '../host/client.ts';

/**
 * Evaluates host-compiled user scripts (CommonJS, virtual module 'aige' -> global __aigeRuntime).
 * Each script is wrapped into an ES module and imported from a blob: URL, so the renderer's CSP only
 * needs `script-src blob:` instead of 'unsafe-eval'.
 */
export async function evaluateScripts(
  compiled: CompiledScript[],
): Promise<{ scripts: Record<string, BehaviourClass>; errors: string[] }> {
  window.__aigeRuntime = api;
  const scripts: Record<string, BehaviourClass> = {};
  const errors: string[] = [];
  for (const { path, code } of compiled) {
    const src = `const __aigeModule = { exports: {} };\n(function (module, exports) {\n${code}\n})(__aigeModule, __aigeModule.exports);\nexport default __aigeModule.exports;\n`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    try {
      const mod = (await import(/* @vite-ignore */ url)) as { default: { default?: unknown } };
      const exp = mod.default;
      const cls = (exp.default ?? exp) as BehaviourClass;
      if (typeof cls !== 'function')
        errors.push(`${path}: the script must \`export default class ... extends Behaviour\`.`);
      else scripts[path] = cls;
    } catch (err) {
      errors.push(`${path}: ${(err as Error).message}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return { scripts, errors };
}

/** Compiles (host) and evaluates (renderer) every project script. */
export async function loadProjectScripts(): Promise<{
  scripts: Record<string, BehaviourClass>;
  errors: string[];
}> {
  const res = await host.request<{ scripts: CompiledScript[]; errors: { path: string; message: string }[] }>({
    type: 'editor.scripts',
  });
  const evaluated = await evaluateScripts(res.scripts);
  return {
    scripts: evaluated.scripts,
    errors: [...res.errors.map((e) => `${e.path}: ${e.message}`), ...evaluated.errors],
  };
}

let propsCache: { key: string; props: Record<string, Record<string, unknown>> } | null = null;

/** Static props of built-in and project scripts (for the inspector). Cached by script file versions. */
export async function scriptProps(versionKey: string): Promise<Record<string, Record<string, unknown>>> {
  if (propsCache?.key === versionKey) return propsCache.props;
  const { builtinBehaviours } = await import('@aige/runtime');
  const props: Record<string, Record<string, unknown>> = {};
  for (const [name, cls] of Object.entries(builtinBehaviours))
    props[`builtin:${name}`] = { ...(cls.props ?? {}) };
  try {
    const { scripts } = await loadProjectScripts();
    for (const [path, cls] of Object.entries(scripts)) props[path] = { ...(cls.props ?? {}) };
  } catch {
    // no project scripts / compile errors: built-ins only
  }
  propsCache = { key: versionKey, props };
  return props;
}
