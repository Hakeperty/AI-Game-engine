#!/usr/bin/env node
/**
 * aige: command-line entry point.
 *   aige mcp        run the MCP server over stdio (for Claude Code / Claude Desktop)
 *   aige new        create a project
 *   aige call       run any tool against a project (images are saved to files)
 *   aige screenshot render a scene or model to a PNG
 *   aige tools      list tools
 *   aige replay     rebuild a project from its command log
 *   aige doctor     check the environment (browser, GPU, Ollama)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ToolResult } from '@aige/core';
import { DEFAULT_WORKSPACE_DIR, ProjectHost, projectRootFor, Workspace } from '@aige/host';

const USAGE = `aige: AI-native game engine

Usage:
  aige mcp [--project <dir>] [--workspace <dir>] [--no-render]
  aige new <name> [--dir <dir>] [--template basic|empty]
  aige call <tool> [json-input] [--project <dir>] [--out <file.png>]
  aige screenshot [--project <dir>] [--model <path>] [--views camera,iso] [--out shot.png]
  aige tools [--json]
  aige replay --project <dir> --into <newDir>
  aige doctor

Register with Claude Code:
  claude mcp add aige -- node ${resolve(import.meta.dirname, '..', 'bin', 'aige.mjs').replaceAll('\\', '/')} mcp
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: 'string', short: 'p' },
    workspace: { type: 'string', short: 'w' },
    dir: { type: 'string' },
    template: { type: 'string' },
    'no-render': { type: 'boolean' },
    out: { type: 'string', short: 'o' },
    model: { type: 'string' },
    views: { type: 'string' },
    json: { type: 'boolean' },
    into: { type: 'string' },
    standalone: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, ...rest] = positionals;

function projectDir(): string {
  const dir = values.project ? resolve(values.project) : projectRootFor(process.cwd());
  if (!dir) fail('No project found. Pass --project <dir> or run inside a project folder.');
  return dir;
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function printResult(r: ToolResult, out?: string): void {
  if (!r.ok) {
    process.stderr.write(`${JSON.stringify(r.error, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const result = r.result as { images?: { data: string; path?: string; label?: string }[] } | undefined;
  if (result?.images?.length) {
    result.images.forEach((img, i) => {
      const file = out ? (i === 0 ? out : out.replace(/(\.png)?$/, `-${i + 1}.png`)) : `aige-image-${i + 1}.png`;
      writeFileSync(file, Buffer.from(img.data, 'base64'));
      (img as { data?: string }).data = undefined;
      (img as { saved?: string }).saved = resolve(file);
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main(): Promise<void> {
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }
  switch (command) {
    case 'mcp': {
      // stdout is the MCP channel: send every stray log to stderr
      console.log = console.error;
      console.info = console.error;
      const { createMcpServer } = await import('@aige/mcp');
      const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
      const ws = new Workspace({
        workspaceDir: values.workspace ?? DEFAULT_WORKSPACE_DIR,
        ...(values['no-render'] ? { render: null } : {}),
      });
      // If the editor is running, drive it (the user watches the game being built live).
      const { readLiveLock, RemoteHostClient } = await import('@aige/host');
      const lock = values.standalone ? null : readLiveLock();
      let api: import('@aige/mcp').HostApi;
      if (lock) {
        const remote = await RemoteHostClient.connect(lock);
        api = {
          tools: () => remote.request({ type: 'tools' }),
          call: async (name, input) => {
            const res = await remote.request<{ __error?: import('@aige/core').ErrorInfo }>({ type: 'call', name, input, source: 'mcp' });
            return res && typeof res === 'object' && '__error' in res && res.__error
              ? { ok: false as const, error: res.__error }
              : { ok: true as const, result: res };
          },
        };
        process.stderr.write(`aige: attached to running editor (pid ${lock.pid})\n`);
      } else {
        if (values.project) await ws.open(resolve(values.project));
        api = { tools: () => ws.tools(), call: (n: string, i: unknown) => ws.call(n, i, 'mcp') };
      }
      const handle = serveStdio(() => createMcpServer(api), { onerror: (e) => process.stderr.write(`mcp error: ${e.message}\n`) });
      const shutdown = async () => {
        await handle.close().catch(() => undefined);
        await ws.close().catch(() => undefined);
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.stdin.on('end', shutdown);
      process.stderr.write(`aige MCP server ready (workspace: ${ws.dir}${ws.current ? `, project: ${ws.current.root}` : ''})\n`);
      return;
    }
    case 'new': {
      const name = rest[0] ?? fail('aige new <name>');
      const dir = resolve(values.dir ?? name);
      const host = await ProjectHost.create(dir, { name, template: values.template === 'empty' ? 'empty' : 'basic' }, { render: null });
      await host.close();
      process.stdout.write(`Created ${dir}\n`);
      return;
    }
    case 'tools': {
      const ws = new Workspace({ render: null });
      const tools = await ws.tools();
      if (values.json) process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
      else for (const t of tools) process.stdout.write(`${t.name.padEnd(22)} ${t.kind.padEnd(8)} ${t.description.split('\n')[0]!.slice(0, 100)}\n`);
      await ws.close();
      return;
    }
    case 'call': {
      const tool = rest[0] ?? fail('aige call <tool> [json]');
      let input: unknown = {};
      if (rest[1]) {
        const raw = existsSync(rest[1]) ? readFileSync(rest[1], 'utf8') : rest[1];
        try {
          input = JSON.parse(raw);
        } catch (err) {
          fail(`Input is not valid JSON: ${(err as Error).message}`);
        }
      }
      const host = await ProjectHost.open(projectDir());
      printResult(await host.call(tool, input, 'cli'), values.out);
      await host.close();
      return;
    }
    case 'screenshot': {
      const host = await ProjectHost.open(projectDir());
      const views = values.views?.split(',').map((v) => v.trim());
      const r = values.model
        ? await host.call('model_preview', { model: values.model, ...(views ? { views } : {}) }, 'cli')
        : await host.call('render_screenshot', views ? { views } : {}, 'cli');
      printResult(r, values.out ?? 'screenshot.png');
      await host.close();
      return;
    }
    case 'replay': {
      const src = projectDir();
      const into = values.into ?? fail('--into <newDir> is required');
      const log = readFileSync(resolve(src, '.aige/logs/commands.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const srcHost = await ProjectHost.open(src, { render: null });
      const name = srcHost.state.project.name;
      await srcHost.close();
      const host = await ProjectHost.create(resolve(into), { name, template: 'basic' }, { render: null });
      const n = await host.bus.replay(log);
      await host.close();
      process.stdout.write(`Replayed ${n} commands into ${resolve(into)}\n`);
      return;
    }
    case 'doctor': {
      const report: Record<string, unknown> = { node: process.version, platform: `${process.platform}-${process.arch}` };
      const { PlaywrightBackend } = await import('@aige/host');
      const backend = new PlaywrightBackend();
      try {
        report.renderer = await backend.info();
      } catch (err) {
        report.renderer = `unavailable: ${(err as Error).message}`;
      } finally {
        await backend.close();
      }
      try {
        const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
        const tags = (await res.json()) as { models?: { name: string }[] };
        report.ollama = tags.models?.map((m) => m.name) ?? [];
      } catch {
        report.ollama = 'not reachable at http://localhost:11434';
      }
      report.anthropicKey = process.env.ANTHROPIC_API_KEY ? 'set' : 'not set (in-editor Claude agent needs it, MCP does not)';
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    default:
      fail(`Unknown command '${command}'.\n\n${USAGE}`);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
