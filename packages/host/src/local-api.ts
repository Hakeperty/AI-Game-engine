import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { Workspace } from './host.ts';
import { type ClientMessage, HostEndpoint, type ServerMessage } from './protocol.ts';

/** Where a running editor advertises its local API (so `aige mcp` can attach to it). */
export const EDITOR_LOCK = join(homedir(), '.aige', 'editor.json');

export interface LockInfo {
  port: number;
  token: string;
  pid: number;
  root: string | null;
  startedAt: string;
}

export interface LocalApi {
  port: number;
  token: string;
  close(): Promise<void>;
}

/**
 * Serves the host protocol over WebSocket on 127.0.0.1 (random port). Clients must send the bearer
 * token (Authorization header or ?token=). Browser origins are rejected (DNS-rebinding / CSRF).
 * Writes ~/.aige/editor.json and <project>/.aige/host.json so MCP servers can find and attach to it.
 */
export async function startLocalApi(workspace: Workspace, opts: { port?: number; lockFile?: string | null } = {}): Promise<LocalApi> {
  const token = randomBytes(24).toString('hex');
  const http: Server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if (!authorized(req, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (socket: WebSocket) => {
    const send = (msg: ServerMessage) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    };
    const endpoint = new HostEndpoint(workspace, send);
    socket.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      void endpoint.handle(msg);
    });
    socket.on('close', () => endpoint.dispose());
  });
  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const lockFile = opts.lockFile === undefined ? EDITOR_LOCK : opts.lockFile;
  const writeLocks = () => {
    const info: LockInfo = { port, token, pid: process.pid, root: workspace.current?.root ?? null, startedAt: new Date().toISOString() };
    if (lockFile) writeJson(lockFile, info);
    if (workspace.current) writeJson(join(workspace.current.root, '.aige', 'host.json'), info);
  };
  writeLocks();
  const unsub = workspace.onChange(() => writeLocks());
  return {
    port,
    token,
    async close() {
      unsub();
      for (const c of wss.clients) c.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      if (lockFile && existsSync(lockFile)) {
        try {
          const cur = JSON.parse(readFileSync(lockFile, 'utf8')) as LockInfo;
          if (cur.pid === process.pid) rmSync(lockFile);
        } catch {
          // ignore
        }
      }
      const hostLock = workspace.current ? join(workspace.current.root, '.aige', 'host.json') : null;
      if (hostLock && existsSync(hostLock)) rmSync(hostLock);
    },
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function authorized(req: IncomingMessage, token: string): boolean {
  // Reject requests from web pages (they always send an Origin); CLI/Node/Electron-main clients don't.
  const origin = req.headers.origin;
  if (origin && !origin.startsWith('file://') && origin !== 'null') return false;
  const host = (req.headers.host ?? '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') return false;
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token');
  const given = header ?? query ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reads a lock file and checks that its process is still alive. */
export function readLiveLock(path: string = EDITOR_LOCK): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

/** Minimal WebSocket client for the host protocol (used by `aige mcp` to attach to a running editor). */
export class RemoteHostClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  readonly events = new Set<(msg: ServerMessage) => void>();

  static async connect(lock: LockInfo): Promise<RemoteHostClient> {
    const client = new RemoteHostClient();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${lock.port}/`, { headers: { authorization: `Bearer ${lock.token}` } });
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.on('message', (data) => client.onMessage(JSON.parse(String(data)) as ServerMessage));
      ws.on('close', () => {
        for (const p of client.pending.values()) p.reject(new Error('Editor connection closed.'));
        client.pending.clear();
      });
      client.socket = ws;
    });
    return client;
  }

  private onMessage(msg: ServerMessage): void {
    if (msg.type === 'reply') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.resolve({ __error: msg.error });
      return;
    }
    for (const l of this.events) l(msg);
  }

  request<T = unknown>(msg: Omit<ClientMessage, 'id'> & Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket!.send(JSON.stringify({ ...msg, id }));
    });
  }

  close(): void {
    this.socket?.close();
  }
}
