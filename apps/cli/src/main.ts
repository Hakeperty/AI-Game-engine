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
  aige editor [--project <dir>]
  aige mcp [--project <dir>] [--workspace <dir>] [--no-render] [--standalone]
  aige agent "<what to build>" [-p <dir>] [--provider anthropic|ollama|arcflare] [--model <id>] [--base-url <url>]
  aige new <name> [--dir <dir>] [--template basic|empty]
  aige call <tool> [json-input] [--project <dir>] [--out <file.png>]
  aige screenshot [--project <dir>] [--model <path>] [--views camera,iso] [--out shot.png]
  aige tools [--json]
  aige replay --project <dir> --into <newDir>
  aige doctor
  aige godot setup|status|export|open [-p <dir>]
  aige tts setup|status|stop

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
    provider: { type: 'string' },
    'base-url': { type: 'string' },
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
      const file = out
        ? i === 0
          ? out
          : out.replace(/(\.png)?$/, `-${i + 1}.png`)
        : `aige-image-${i + 1}.png`;
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
            const res = await remote.request<{ __error?: import('@aige/core').ErrorInfo }>({
              type: 'call',
              name,
              input,
              source: 'mcp',
            });
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
      const handle = serveStdio(() => createMcpServer(api), {
        onerror: (e) => process.stderr.write(`mcp error: ${e.message}\n`),
      });
      const shutdown = async () => {
        await handle.close().catch(() => undefined);
        await ws.close().catch(() => undefined);
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.stdin.on('end', shutdown);
      process.stderr.write(
        `aige MCP server ready (workspace: ${ws.dir}${ws.current ? `, project: ${ws.current.root}` : ''})\n`,
      );
      return;
    }
    case 'new': {
      const name = rest[0] ?? fail('aige new <name>');
      const dir = resolve(values.dir ?? name);
      const host = await ProjectHost.create(
        dir,
        { name, template: values.template === 'empty' ? 'empty' : 'basic' },
        { render: null },
      );
      await host.close();
      process.stdout.write(`Created ${dir}\n`);
      return;
    }
    case 'tools': {
      const ws = new Workspace({ render: null });
      const tools = await ws.tools();
      if (values.json) process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
      else
        for (const t of tools)
          process.stdout.write(
            `${t.name.padEnd(22)} ${t.kind.padEnd(8)} ${t.description.split('\n')[0]!.slice(0, 100)}\n`,
          );
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
      const log = readFileSync(resolve(src, '.aige/logs/commands.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const srcHost = await ProjectHost.open(src, { render: null });
      const name = srcHost.state.project.name;
      await srcHost.close();
      const host = await ProjectHost.create(resolve(into), { name, template: 'basic' }, { render: null });
      const n = await host.bus.replay(log);
      await host.close();
      process.stdout.write(`Replayed ${n} commands into ${resolve(into)}\n`);
      return;
    }
    case 'godot': {
      // Godot 4 .NET game runtime: aige godot setup | status | export | open
      const sub = rest[0] ?? 'status';
      const { GODOT_DIR, GODOT_DOWNLOAD, godotExe, godotInstalled } = await import('@aige/host');
      if (sub === 'setup') {
        if (godotInstalled()) {
          process.stdout.write(`Godot is already installed: ${godotExe()}\n`);
          return;
        }
        const { mkdirSync } = await import('node:fs');
        const { spawnSync } = await import('node:child_process');
        mkdirSync(GODOT_DIR, { recursive: true });
        const zip = resolve(GODOT_DIR, 'godot.zip');
        process.stdout.write(`Downloading ${GODOT_DOWNLOAD} ...\n`);
        const res = await fetch(GODOT_DOWNLOAD);
        if (!res.ok) fail(`Download failed (${res.status}).`);
        writeFileSync(zip, new Uint8Array(await res.arrayBuffer()));
        if (spawnSync('tar', ['-xf', zip, '-C', GODOT_DIR], { stdio: 'inherit' }).status !== 0)
          fail('Unzip failed.');
        (await import('node:fs')).rmSync(zip);
        if (spawnSync('dotnet', ['--version'], { encoding: 'utf8' }).status !== 0)
          process.stdout.write(
            'Note: the .NET SDK (8 or newer) is needed to build C# games: https://dotnet.microsoft.com/download\n',
          );
        process.stdout.write(`Godot ready: ${godotExe()}\n`);
        return;
      }
      if (sub === 'status') {
        process.stdout.write(
          `${JSON.stringify({ installed: godotInstalled(), exe: godotExe() }, null, 2)}\n`,
        );
        return;
      }
      if (sub === 'export' || sub === 'open') {
        const host = await ProjectHost.open(projectDir(), { render: null });
        try {
          printResult(
            await host.call(sub === 'export' ? 'godot_export' : 'godot_open', {}, 'cli'),
            values.out,
          );
        } finally {
          await host.close();
        }
        return;
      }
      fail(`Unknown: aige godot ${sub} (use setup, status, export or open)`);
      return;
    }
    case 'tts': {
      // Local Qwen3-TTS voice engine: aige tts setup | status | stop
      const sub = rest[0] ?? 'status';
      const { tts, ttsPython } = await import('@aige/host');
      if (sub === 'status') {
        process.stdout.write(`${JSON.stringify(await tts.status(), null, 2)}\n`);
        return;
      }
      if (sub === 'stop') {
        const lock = resolve(process.env.USERPROFILE ?? process.env.HOME ?? '', '.aige', 'tts.json');
        if (existsSync(lock)) {
          const { pid } = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number };
          try {
            process.kill(pid);
            process.stdout.write(`Stopped voice server (pid ${pid}).\n`);
          } catch {
            process.stdout.write('Voice server was not running.\n');
          }
        }
        return;
      }
      if (sub === 'setup') {
        const { spawnSync } = await import('node:child_process');
        const ttsDir = resolve(import.meta.dirname, '..', '..', '..', 'tools', 'tts');
        const uv = spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0 ? 'uv' : null;
        if (!uv)
          fail('uv is required (https://docs.astral.sh/uv/). Install it, then re-run `aige tts setup`.');
        const run = (args: string[]) => {
          process.stdout.write(`> uv ${args.join(' ')}\n`);
          if (spawnSync(uv, args, { stdio: 'inherit', cwd: ttsDir }).status !== 0) fail('Setup step failed.');
        };
        if (!existsSync(ttsPython())) run(['venv', '.venv', '--python', '3.12']);
        run([
          'pip',
          'install',
          '--python',
          ttsPython(),
          'torch',
          'torchaudio',
          '--index-url',
          'https://download.pytorch.org/whl/cu128',
        ]);
        run([
          'pip',
          'install',
          '--python',
          ttsPython(),
          'qwen-tts',
          'soundfile',
          'numpy',
          'transformers',
          'accelerate',
        ]);
        process.stdout.write('Downloading Qwen3-TTS + Whisper models (a few GB)...\n');
        const dl = spawnSync(
          ttsPython(),
          [
            '-c',
            'from huggingface_hub import snapshot_download as d\nfor m in ["Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign","Qwen/Qwen3-TTS-12Hz-1.7B-Base","openai/whisper-small.en","microsoft/wavlm-base-plus-sv"]: print(d(m))',
          ],
          { stdio: 'inherit' },
        );
        if (dl.status !== 0) fail('Model download failed.');
        process.stdout.write('Voice engine ready. Try: aige tts status\n');
        return;
      }
      fail('aige tts setup | status | stop');
      return;
    }
    case 'editor': {
      // Launch the desktop editor (builds it on first run). Optional: --project <dir> to open.
      const editorDir = resolve(import.meta.dirname, '..', '..', 'editor');
      const { spawn, spawnSync } = await import('node:child_process');
      if (!existsSync(resolve(editorDir, 'dist', 'main.cjs'))) {
        process.stdout.write('Building the editor (first run)...\n');
        const b = spawnSync(process.execPath, [resolve(editorDir, 'scripts', 'build.mjs')], {
          stdio: 'inherit',
          cwd: editorDir,
        });
        if (b.status !== 0) fail('Editor build failed.');
      }
      const { createRequire } = await import('node:module');
      const electronPath = createRequire(resolve(editorDir, 'package.json'))('electron') as unknown as string;
      const env = {
        ...process.env,
        ...(values.project ? { AIGE_OPEN_PROJECT: resolve(values.project) } : {}),
      };
      const child = spawn(electronPath, [editorDir], { stdio: 'inherit', env, detached: false });
      child.on('exit', (code) => process.exit(code ?? 0));
      return;
    }
    case 'agent': {
      // Run the in-editor agent headlessly: aige agent "make a spinning red cube" -p my-game --provider ollama
      const prompt =
        rest.join(' ') ||
        fail('aige agent "<what to build>" [-p project] [--provider anthropic|ollama|arcflare] [--model id]');
      const { Agent, createProvider, DEFAULT_ANTHROPIC_MODEL, DEFAULT_OLLAMA_BASE_URL } = await import(
        '@aige/agent'
      );
      const { workspaceToolHost } = await import('@aige/host');
      const ws = new Workspace({ workspaceDir: values.workspace ?? DEFAULT_WORKSPACE_DIR });
      if (values.project) {
        const dir = resolve(values.project);
        if (existsSync(resolve(dir, 'project.json'))) await ws.open(dir);
        else await ws.create(dir.split(/[\\/]/).pop()!, dir);
      }
      const providerKind = values.provider ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'ollama');
      let provider: ReturnType<typeof createProvider>;
      if (providerKind === 'anthropic') {
        provider = createProvider({ kind: 'anthropic', model: values.model ?? DEFAULT_ANTHROPIC_MODEL });
      } else if (providerKind === 'arcflare') {
        // ArcFlare (github.com/Hakeperty/ArcFlare-Code) serves local GGUF models through llama-server's
        // OpenAI-compatible API; its port is in ~/.arcflare/server.json.
        const baseURL = values['base-url'] ?? process.env.ARCFLARE_URL ?? arcflareBaseUrl();
        const model = values.model ?? (await firstServedModel(baseURL));
        if (!model)
          fail(`No model is loaded in ArcFlare at ${baseURL}. Start one with \`arcflare\`, or pass --model.`);
        process.stderr.write(`aige: using ArcFlare model '${model}' at ${baseURL}\n`);
        provider = createProvider({ kind: 'openai-compat', baseURL, model });
      } else {
        provider = createProvider({
          kind: 'openai-compat',
          baseURL: values['base-url'] ?? DEFAULT_OLLAMA_BASE_URL,
          model: values.model ?? 'qwen3.8:27b',
        });
      }
      let imageN = 0;
      const agent = new Agent({
        provider,
        tools: workspaceToolHost(ws),
        onEvent: (e) => {
          switch (e.type) {
            case 'text':
              process.stdout.write(e.delta);
              break;
            case 'tool_start':
              process.stdout.write(`\n\x1b[36m→ ${e.name}\x1b[0m ${JSON.stringify(e.input).slice(0, 160)}\n`);
              break;
            case 'tool_end':
              process.stdout.write(
                `${e.ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${e.name}\x1b[0m ${e.durationMs}ms ${(e.error?.message ?? e.summary).slice(0, 200)}\n`,
              );
              break;
            case 'image': {
              const file = resolve(`aige-agent-${++imageN}.png`);
              writeFileSync(file, Buffer.from(e.image.data, 'base64'));
              process.stdout.write(`  [image saved: ${file}]\n`);
              break;
            }
            case 'plan':
              process.stdout.write(
                `\n\x1b[33mplan:\x1b[0m ${e.items.map((i) => `${i.status === 'done' ? '✓' : i.status === 'in_progress' ? '▸' : '·'} ${i.text}`).join(' | ')}\n`,
              );
              break;
            case 'usage':
              process.stderr.write(`\x1b[2m[${e.model}: $${e.runCostUsd.toFixed(4)} this run]\x1b[0m\n`);
              break;
          }
        },
      });
      const result = await agent.run(prompt);
      process.stdout.write(`\n\n[done: ${JSON.stringify(result).slice(0, 300)}]\n`);
      await ws.close();
      return;
    }
    case 'doctor': {
      const report: Record<string, unknown> = {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      };
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
      report.anthropicKey = process.env.ANTHROPIC_API_KEY
        ? 'set'
        : 'not set (in-editor Claude agent needs it, MCP does not)';
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    default:
      fail(`Unknown command '${command}'.\n\n${USAGE}`);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));

/** ArcFlare's OpenAI-compatible endpoint from ~/.arcflare/server.json (default port 11434). */
function arcflareBaseUrl(): string {
  const home =
    process.env.ARCFLARE_HOME ?? resolve(process.env.USERPROFILE ?? process.env.HOME ?? '', '.arcflare');
  try {
    const info = JSON.parse(readFileSync(resolve(home, 'server.json'), 'utf8')) as { port?: number };
    return `http://127.0.0.1:${info.port ?? 11434}/v1`;
  } catch {
    return 'http://127.0.0.1:11434/v1';
  }
}

async function firstServedModel(baseURL: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(4000) });
    const j = (await res.json()) as { data?: { id: string }[] };
    return j.data?.[0]?.id;
  } catch {
    return undefined;
  }
}
