import type { BusEvent, CommandSource, ProjectState, ToolDefinition, ToolResult } from '@aige/core';
import { toErrorInfo } from '@aige/core';
import { toBase64 } from '@aige/modeling';
import type { ModelInfo } from './assets.ts';
import type { ProjectHost, Workspace } from './host.ts';

/**
 * Message protocol between the host and its clients (the editor renderer over a MessagePort,
 * MCP servers and tools over WebSocket). JSON-serializable in both directions.
 */
export type ClientMessage =
  | { id: number; type: 'call'; name: string; input?: unknown; source?: CommandSource }
  | { id: number; type: 'tools' }
  | { id: number; type: 'state' }
  | { id: number; type: 'model'; path: string; params?: Record<string, unknown> }
  | { id: number; type: 'subscribe' }
  | { id: number; type: 'transaction'; label: string; calls: { name: string; input?: unknown }[]; source?: CommandSource };

export type ServerMessage =
  | { type: 'reply'; id: number; ok: true; result: unknown }
  | { type: 'reply'; id: number; ok: false; error: { code: string; message: string; hint?: string } }
  | { type: 'event'; event: BusEvent }
  | { type: 'project'; root: string | null; state: ProjectState | null; version: number };

export interface StateSnapshot {
  root: string | null;
  state: ProjectState | null;
  version: number;
}

export interface ModelAsset {
  key: string;
  info: ModelInfo;
  /** base64 GLB */
  glb: string;
}

/**
 * Transport-independent request handler. One endpoint per connected client; it follows the
 * workspace's current project and forwards bus events once the client subscribes.
 */
export class HostEndpoint {
  private readonly ws: Workspace;
  private readonly send: (msg: ServerMessage) => void;
  private subscribed = false;
  private unsubBus: (() => void) | null = null;
  private readonly unsubWs: () => void;

  constructor(workspace: Workspace, send: (msg: ServerMessage) => void) {
    this.ws = workspace;
    this.send = send;
    this.unsubWs = workspace.onChange((host) => {
      this.attach(host);
      if (this.subscribed) this.send({ type: 'project', ...this.snapshot() });
    });
    this.attach(workspace.current);
  }

  private attach(host: ProjectHost | null): void {
    this.unsubBus?.();
    this.unsubBus = host
      ? host.bus.on((event) => {
          if (this.subscribed) this.send({ type: 'event', event });
        })
      : null;
  }

  private snapshot(): StateSnapshot {
    const host = this.ws.current;
    return { root: host?.root ?? null, state: host?.state ?? null, version: host?.bus.version ?? 0 };
  }

  async handle(msg: ClientMessage): Promise<void> {
    const reply = (result: unknown) => this.send({ type: 'reply', id: msg.id, ok: true, result });
    const fail = (err: unknown) => this.send({ type: 'reply', id: msg.id, ok: false, error: toErrorInfo(err) });
    try {
      switch (msg.type) {
        case 'call': {
          const r: ToolResult = await this.ws.call(msg.name, msg.input ?? {}, msg.source ?? 'ui');
          this.send(r.ok ? { type: 'reply', id: msg.id, ok: true, result: r.result } : { type: 'reply', id: msg.id, ok: false, error: r.error });
          return;
        }
        case 'tools': {
          const tools: ToolDefinition[] = await this.ws.tools();
          reply(tools);
          return;
        }
        case 'state':
          reply(this.snapshot());
          return;
        case 'subscribe':
          this.subscribed = true;
          reply(this.snapshot());
          return;
        case 'model': {
          const host = this.ws.current;
          if (!host) throw new Error('No project is open.');
          const built = await host.assets.build(msg.path, msg.params ?? {});
          const asset: ModelAsset = { key: built.info.key, info: built.info, glb: toBase64(built.glb) };
          reply(asset);
          return;
        }
        case 'transaction': {
          const host = this.ws.current;
          if (!host) throw new Error('No project is open.');
          const results: ToolResult[] = [];
          await host.bus.transaction(msg.label, msg.source ?? 'ui', async () => {
            for (const c of msg.calls) results.push(await host.call(c.name, c.input ?? {}, msg.source ?? 'ui'));
          });
          reply(results);
          return;
        }
      }
    } catch (err) {
      fail(err);
    }
  }

  dispose(): void {
    this.unsubBus?.();
    this.unsubWs();
  }
}
