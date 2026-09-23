import type { ErrorInfo, ToolResult } from '@aige/core';
import { type ClientMessage, HOST_PORT_MESSAGE, type ServerMessage } from '../../shared/protocol.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Request = DistributiveOmit<ClientMessage, 'id'>;

export class HostError extends Error {
  readonly info: ErrorInfo;
  constructor(info: ErrorInfo) {
    super(info.message);
    this.info = info;
  }
}

/**
 * The renderer's connection to the host utility process: a MessagePort handed over by the preload.
 * Speaks the same protocol MCP clients use, plus the editor.* / agent.* extensions.
 */
export class HostClient {
  private port: MessagePort | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  private readonly connectListeners = new Set<() => void>();

  constructor() {
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.data !== HOST_PORT_MESSAGE || !e.ports[0]) return;
      this.attach(e.ports[0]);
    });
  }

  get connected(): boolean {
    return this.port !== null;
  }

  connect(): void {
    window.aige.connectHost();
  }

  private attach(port: MessagePort): void {
    this.port?.close();
    for (const p of this.pending.values()) p.reject(new Error('The host connection was reset.'));
    this.pending.clear();
    this.port = port;
    port.onmessage = (e) => this.onMessage(e.data as ServerMessage);
    port.start();
    for (const l of this.connectListeners) l();
  }

  private onMessage(msg: ServerMessage): void {
    if (msg.type === 'reply') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new HostError(msg.error));
      return;
    }
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch (err) {
        console.error(err);
      }
    }
  }

  onMessageEvent(fn: (msg: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onConnect(fn: () => void): () => void {
    this.connectListeners.add(fn);
    return () => this.connectListeners.delete(fn);
  }

  /** Sends a request; rejects with HostError when the host replies with an error. */
  request<T = unknown>(msg: Request): Promise<T> {
    const port = this.port;
    if (!port)
      return Promise.reject(new HostError({ code: 'INVALID_STATE', message: 'Not connected to the host.' }));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      port.postMessage({ ...msg, id });
    });
  }

  /** Calls a tool. Never throws: resolves to { ok, result } or { ok: false, error }. */
  async call<T = any>(name: string, input: unknown = {}): Promise<ToolResult<T>> {
    try {
      const result = await this.request<T>({ type: 'call', name, input, source: 'ui' });
      return { ok: true, result };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof HostError ? err.info : { code: 'INTERNAL', message: String(err) },
      };
    }
  }
}

export const host = new HostClient();
