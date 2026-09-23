import { spawn } from 'node:child_process';
import { join, relative } from 'node:path';
import { AigeError, defineCommand } from '@aige/core';
import { z } from 'zod';
import type { HostServices } from './commands.ts';
import type { ProjectFs } from './fs.ts';
import { ENGINE_ROOT, writeProjectSupportFiles } from './project-io.ts';
import { compileUserModule, runModule } from './sandbox.ts';

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

const TSC = join(ENGINE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * Type-checks the project's scripts and model recipes with the engine's TypeScript compiler
 * (the project tsconfig maps 'aige' and 'aige/model' to the engine sources).
 * Only diagnostics inside the project are returned.
 */
export async function typecheckProject(
  fs: ProjectFs,
  opts: { files?: string[] } = {},
): Promise<Diagnostic[]> {
  if (!(await fs.exists('tsconfig.json'))) await writeProjectSupportFiles(fs);
  const out = await new Promise<string>((resolve) => {
    const child = spawn(
      process.execPath,
      [TSC, '-p', fs.abs('tsconfig.json'), '--pretty', 'false', '--noEmit'],
      { cwd: fs.root },
    );
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('close', () => resolve(text));
    child.on('error', (err) => resolve(`tsc failed to start: ${err.message}`));
  });
  const diags: Diagnostic[] = [];
  const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
  let last: Diagnostic | null = null;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(re);
    if (m) {
      const abs = m[1]!;
      const file = relative(fs.root, join(fs.root, abs)).split('\\').join('/');
      last = { file, line: Number(m[2]), column: Number(m[3]), code: m[4]!, message: m[5]! };
      if (!file.startsWith('..') && !file.includes('node_modules')) diags.push(last);
      else last = null;
    } else if (last && line.startsWith('  ')) {
      last.message += `\n${line.trim()}`;
    }
  }
  if (opts.files?.length) {
    const set = new Set(opts.files.map((f) => f.replaceAll('\\', '/')));
    return diags.filter((d) => set.has(d.file));
  }
  return diags;
}

export function formatDiagnostics(diags: Diagnostic[], max = 20): string[] {
  return diags.slice(0, max).map((d) => `${d.file}:${d.line}:${d.column} ${d.code}: ${d.message}`);
}

const host = (ctx: { services: unknown }) => (ctx.services as HostServices).host;

function scriptPath(nameOrPath: string): string {
  const p = nameOrPath.replaceAll('\\', '/');
  if (p.includes('/')) return p.endsWith('.ts') ? p : `${p}.ts`;
  return `scripts/${p.replace(/\.ts$/, '')}.ts`;
}

export const scriptWrite = defineCommand({
  name: 'script_write',
  group: 'scripting',
  kind: 'mutation',
  tier: 'core',
  description: `Write a gameplay script (scripts/<name>.ts), compile it and type-check it against the engine API. It returns TypeScript diagnostics with file:line; fix them and write again. The script must \`export default class X extends Behaviour\`. Read api_docs topic 'scripting' first. Attach it with {"type":"Script","script":"scripts/<name>.ts","props":{...}}.
Example: {"name":"spinner","source":"import { Behaviour } from 'aige';\\nexport default class Spinner extends Behaviour {\\n  static props = { speed: 90 };\\n  update(dt: number) { this.entity.rotate([0, this.props.speed * dt, 0]); }\\n}\\n"}`,
  input: z
    .object({
      name: z.string().min(1).describe("Script name ('player') or path ('scripts/enemies/bat.ts')"),
      source: z.string().min(10),
      typecheck: z.boolean().default(true),
    })
    .strict(),
  async run(ctx, input) {
    const path = scriptPath(input.name);
    await ctx.writeFile(path, input.source);
    const h = host(ctx);
    // Syntax/import errors fail the call (and roll the write back).
    const mod = await compileUserModule({
      entry: h.fs.abs(path),
      root: h.fs.root,
      virtuals: { aige: '__aigeRuntime' },
    });
    // The default export must be a Behaviour subclass.
    const { api } = await import('@aige/runtime');
    const { exports } = runModule(mod, { filename: path, globals: { __aigeRuntime: api }, timeoutMs: 2000 });
    const cls = exports.default;
    if (typeof cls !== 'function' || !(cls.prototype instanceof api.Behaviour)) {
      throw new AigeError(
        'INVALID_INPUT',
        `${path} must \`export default class <Name> extends Behaviour\` (import { Behaviour } from 'aige').`,
        {
          hint: "import { Behaviour } from 'aige';\nexport default class Mover extends Behaviour { update(dt: number) { /* ... */ } }",
        },
      );
    }
    const diagnostics = input.typecheck ? await typecheckProject(h.fs, { files: [path] }) : [];
    return {
      script: path,
      usage: `{"type":"Script","script":"${path}"}`,
      typeErrors: diagnostics.length,
      diagnostics: formatDiagnostics(diagnostics),
      ...(diagnostics.length
        ? { hint: 'The file was saved, but it has type errors. Fix them and call script_write again.' }
        : {}),
    };
  },
});

export const scriptTypecheck = defineCommand({
  name: 'script_typecheck',
  group: 'scripting',
  kind: 'query',
  tier: 'extended',
  description:
    'Type-check every script and model recipe in the project. Returns diagnostics as file:line:col messages.',
  input: z.object({}).strict(),
  async run(ctx) {
    const diagnostics = await typecheckProject(host(ctx).fs);
    return {
      ok: diagnostics.length === 0,
      errors: diagnostics.length,
      diagnostics: formatDiagnostics(diagnostics, 50),
    };
  },
});

export const scriptingCommands = [scriptWrite, scriptTypecheck];
