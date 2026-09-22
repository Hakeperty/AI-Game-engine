import vm from 'node:vm';
import { AigeError } from '@aige/core';
import * as esbuild from 'esbuild';
import { SourceMapConsumer } from 'source-map-js';

export interface CompiledModule {
  code: string;
  map: string;
  /** Project-relative files that went into the bundle (for cache keys and watching). */
  inputs: string[];
}

export interface CompileOptions {
  /** Absolute path of the entry file. */
  entry: string;
  /** Project root (for relative file names in errors). */
  root: string;
  /** Virtual modules: import specifier -> global variable name the module is read from. */
  virtuals: Record<string, string>;
}

/**
 * Bundles a user TypeScript file (model recipe or game script) into a CommonJS string.
 * Only relative imports and the given virtual modules ('aige/model', 'aige') are allowed.
 */
export async function compileUserModule(opts: CompileOptions): Promise<CompiledModule> {
  let result: esbuild.BuildResult<{ write: false; metafile: true }>;
  try {
    result = await esbuild.build({
      entryPoints: [opts.entry],
      absWorkingDir: opts.root,
      bundle: true,
      write: false,
      metafile: true,
      format: 'cjs',
      platform: 'neutral',
      target: 'es2023',
      sourcemap: 'external',
      outfile: 'out.js',
      logLevel: 'silent',
      plugins: [
        {
          name: 'aige-virtual',
          setup(b: esbuild.PluginBuild) {
            b.onResolve({ filter: /.*/ }, (args: esbuild.OnResolveArgs) => {
              if (args.path in opts.virtuals) return { path: args.path, namespace: 'aige-virtual' };
              if (args.kind === 'entry-point' || args.path.startsWith('.') || args.path.startsWith('/')) return undefined;
              if (/^[a-zA-Z]:[\\/]/.test(args.path)) return undefined;
              return {
                errors: [
                  {
                    text: `Cannot import '${args.path}'. Only relative files and ${Object.keys(opts.virtuals)
                      .map((v) => `'${v}'`)
                      .join(', ')} can be imported.`,
                  },
                ],
              };
            });
            b.onLoad({ filter: /.*/, namespace: 'aige-virtual' }, (args: esbuild.OnLoadArgs) => ({
              contents: `module.exports = globalThis[${JSON.stringify(opts.virtuals[args.path])}];`,
              loader: 'js',
            }));
          },
        },
      ],
    });
  } catch (err) {
    const failure = err as esbuild.BuildFailure;
    const messages = (failure.errors ?? []).map((e) =>
      e.location ? `${e.location.file}:${e.location.line}:${e.location.column + 1}: ${e.text}` : e.text,
    );
    throw new AigeError('BUILD_FAILED', messages.join('\n') || String(err), {
      hint: 'Fix the syntax error at the given file:line:column.',
      details: { errors: messages },
    });
  }
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))!;
  const map = result.outputFiles.find((f) => f.path.endsWith('.map'))!;
  const inputs = Object.keys(result.metafile.inputs).filter((p) => !p.startsWith('aige-virtual:'));
  return { code: js.text, map: map.text, inputs };
}

export interface RunOptions {
  filename: string;
  /** Globals visible to the module (virtual module objects etc.). */
  globals: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * Evaluates a compiled module inside a fresh V8 context with no Node APIs (no require, process, fs,
 * network, timers). Returns module.exports and captured console output.
 * Note: vm is isolation against accidents, not a security boundary.
 */
export function runModule(mod: CompiledModule, opts: RunOptions): { exports: any; logs: string[]; context: vm.Context } {
  const logs: string[] = [];
  const fmt = (args: unknown[]) => args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ');
  const sandboxConsole = {
    log: (...a: unknown[]) => logs.push(fmt(a)),
    info: (...a: unknown[]) => logs.push(fmt(a)),
    warn: (...a: unknown[]) => logs.push(`warn: ${fmt(a)}`),
    error: (...a: unknown[]) => logs.push(`error: ${fmt(a)}`),
  };
  const module = { exports: {} as any };
  const context = vm.createContext({ ...opts.globals, module, exports: module.exports, console: sandboxConsole });
  try {
    new vm.Script(mod.code, { filename: opts.filename }).runInContext(context, { timeout: opts.timeoutMs ?? 10_000 });
  } catch (err) {
    throw toScriptError(err, mod, opts.filename);
  }
  return { exports: module.exports, logs, context };
}

/** Runs `code` inside an existing module context with a timeout (used to call recipe.build safely). */
export function runInModuleContext<T>(context: vm.Context, code: string, mod: CompiledModule, filename: string, timeoutMs = 20_000): T {
  try {
    return new vm.Script(code, { filename: 'aige-call.js' }).runInContext(context, { timeout: timeoutMs }) as T;
  } catch (err) {
    throw toScriptError(err, mod, filename);
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Converts an error thrown in the sandbox into an AigeError with source-mapped file:line locations. */
export function toScriptError(err: unknown, mod: CompiledModule, filename: string): AigeError {
  const e = err as { message?: string; stack?: string; code?: string } | undefined;
  if (e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
    return new AigeError('TIMEOUT', `${filename} took too long (infinite loop?).`, {
      hint: 'Reduce segment counts / SDF resolution or fix loops that never end.',
    });
  }
  const message = e?.message ?? String(err);
  const frames = mapStack(e?.stack ?? '', mod, filename);
  const where = frames[0] ? ` (at ${frames[0]})` : '';
  return new AigeError('SCRIPT_ERROR', `${message}${where}`, {
    details: { stack: frames.slice(0, 8) },
    hint: frames.length ? `Check ${frames[0]}.` : undefined,
  });
}

function mapStack(stack: string, mod: CompiledModule, filename: string): string[] {
  const consumer = new SourceMapConsumer(JSON.parse(mod.map));
  const out: string[] = [];
  const re = new RegExp(`${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):(\\d+)`, 'g');
  for (const m of stack.matchAll(re)) {
    const pos = consumer.originalPositionFor({ line: Number(m[1]), column: Number(m[2]) - 1 });
    if (pos.source && !pos.source.includes('aige-virtual')) {
      out.push(`${pos.source.replace(/^(\.\.\/)+/, '')}:${pos.line}:${(pos.column ?? 0) + 1}`);
    }
  }
  return [...new Set(out)];
}
