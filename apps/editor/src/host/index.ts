/**
 * Editor host (Electron utility process). Owns the Workspace (the project authority), serves the local
 * WebSocket API so `aige mcp` (Claude Code) can attach to the running editor, runs the in-editor agent,
 * and bridges the host protocol onto a MessagePort per editor window.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_WORKSPACE_DIR, EDITOR_LOCK, type LocalApi, startLocalApi, Workspace } from '@aige/host';
import type { MessagePortMain } from 'electron';
import type { EditorInfo, HostToMain, MainToHost, ServerMessage } from '../shared/protocol.ts';
import { AgentService } from './agent-service.ts';
import { EditorState } from './editor-state.ts';
import { EditorEndpoint, type HostContext } from './endpoint.ts';

interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown; ports: MessagePortMain[] }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  console.error('The AIGE editor host must run in an Electron utility process.');
  process.exit(1);
}

const toMain = (msg: HostToMain) => parentPort.postMessage(msg);

const workspace = new Workspace({
  workspaceDir: resolve(process.env.AIGE_WORKSPACE ?? DEFAULT_WORKSPACE_DIR),
});
const editorState = new EditorState();
const endpoints = new Set<EditorEndpoint>();
let api: LocalApi | null = null;
let apiListeners = 0;

const broadcast = (msg: ServerMessage) => {
  for (const ep of endpoints) ep.send(msg);
};
const agent = new AgentService(workspace, broadcast);

function info(): EditorInfo {
  return {
    workspaceDir: workspace.dir,
    recent: editorState.existingRecent(),
    root: workspace.current?.root ?? null,
    apiPort: api?.port ?? null,
    // startLocalApi keeps one workspace listener for its lock file; every connected client adds one.
    mcpClients: Math.max(0, apiListeners - 1),
  };
}

function broadcastStatus(): void {
  broadcast({ type: 'editor.status', info: info() });
}

const ctx: HostContext = { ws: workspace, state: editorState, agent, info, broadcastStatus };

// Queue messages from main until startup finishes (ports only arrive after 'ready', secrets may not).
let started = false;
const queued: { data: unknown; ports: MessagePortMain[] }[] = [];

parentPort.on('message', (e) => {
  if (!started && (e.data as MainToHost).type === 'port') queued.push(e);
  else void onMainMessage(e);
});

async function onMainMessage(e: { data: unknown; ports: MessagePortMain[] }): Promise<void> {
  const msg = e.data as MainToHost;
  switch (msg.type) {
    case 'port': {
      const port = e.ports[0];
      if (!port) return;
      const ep = new EditorEndpoint(port, ctx);
      endpoints.add(ep);
      port.on('close', () => {
        ep.dispose();
        endpoints.delete(ep);
      });
      port.start();
      return;
    }
    case 'secrets':
      agent.setSecrets({ anthropicApiKey: msg.anthropicApiKey, openaiApiKey: msg.openaiApiKey });
      return;
    case 'shutdown':
      await shutdown();
      return;
  }
}

workspace.onChange((host) => {
  if (host) editorState.opened(host.root, host.state.project.name);
  toMain({ type: 'project', root: host?.root ?? null, name: host?.state.project.name ?? null });
  broadcastStatus();
});

/**
 * startLocalApi() registers one workspace listener for its lock file and one per connected client
 * (HostEndpoint). Counting them through a proxy tells the UI how many MCP clients are attached.
 */
const countedWorkspace = new Proxy(workspace, {
  get(target, prop) {
    if (prop === 'onChange') {
      return (fn: Parameters<Workspace['onChange']>[0]) => {
        const off = target.onChange(fn);
        let active = true;
        apiListeners++;
        broadcastStatus();
        return () => {
          off();
          if (active) {
            active = false;
            apiListeners--;
            broadcastStatus();
          }
        };
      };
    }
    const v = Reflect.get(target, prop, target);
    return typeof v === 'function' ? v.bind(target) : v;
  },
});

async function start(): Promise<void> {
  const initial = process.env.AIGE_OPEN_PROJECT ?? editorState.lastProject;
  if (initial && existsSync(join(initial, 'project.json'))) {
    try {
      await workspace.open(initial);
    } catch (err) {
      console.error(`could not reopen ${initial}: ${(err as Error).message}`);
    }
  }
  try {
    const lockFile = process.env.AIGE_EDITOR_LOCK ? resolve(process.env.AIGE_EDITOR_LOCK) : EDITOR_LOCK;
    api = await startLocalApi(countedWorkspace, { lockFile });
    console.log(`local API on 127.0.0.1:${api.port} (lock: ${lockFile})`);
  } catch (err) {
    console.error(`local API failed to start: ${(err as Error).message}`);
  }
  started = true;
  toMain({ type: 'ready', apiPort: api?.port ?? null });
  const host = workspace.current;
  toMain({ type: 'project', root: host?.root ?? null, name: host?.state.project.name ?? null });
  for (const e of queued.splice(0)) void onMainMessage(e);
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  agent.stop();
  for (const ep of endpoints) ep.dispose();
  endpoints.clear();
  await api?.close().catch(() => undefined);
  await workspace.close().catch(() => undefined);
  process.exit(0);
}

process.on('uncaughtException', (err) => console.error(`uncaught: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (err) =>
  console.error(`unhandled rejection: ${(err as Error)?.stack ?? err}`),
);

start().catch((err) => {
  toMain({ type: 'fatal', message: (err as Error).stack ?? String(err) });
});
