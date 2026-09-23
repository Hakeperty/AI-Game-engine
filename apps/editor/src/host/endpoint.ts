import { AigeError, type ErrorInfo, toErrorInfo } from '@aige/core';
import { HostEndpoint, modelPath, type ProjectHost, type Workspace } from '@aige/host';
import type { MessagePortMain } from 'electron';
import type {
  BaseClientMessage,
  ClientMessage,
  EditorClientMessage,
  EditorInfo,
  ServerMessage,
} from '../shared/protocol.ts';
import type { AgentService } from './agent-service.ts';
import type { EditorState } from './editor-state.ts';
import { compileProjectScripts, readBinaryFile } from './scripts.ts';

export interface HostContext {
  ws: Workspace;
  state: EditorState;
  agent: AgentService;
  info(): EditorInfo;
  broadcastStatus(): void;
}

const thumbnailCache = new Map<string, string>();
let thumbnailQueue: Promise<unknown> = Promise.resolve();

/**
 * One connected editor window. The base protocol (call/tools/state/model/subscribe/transaction) is
 * delegated to @aige/host's HostEndpoint; editor.* and agent.* messages are handled here.
 */
export class EditorEndpoint {
  private readonly port: MessagePortMain;
  private readonly base: HostEndpoint;
  private readonly ctx: HostContext;
  private closed = false;

  constructor(port: MessagePortMain, ctx: HostContext) {
    this.port = port;
    this.ctx = ctx;
    this.base = new HostEndpoint(ctx.ws, (msg) => this.send(msg as ServerMessage));
    port.on('message', (e) => void this.handle(e.data as ClientMessage));
  }

  send(msg: ServerMessage): void {
    if (this.closed) return;
    try {
      this.port.postMessage(msg);
    } catch {
      // Not structured-cloneable (e.g. an Error inside error details): fall back to plain JSON.
      try {
        this.port.postMessage(JSON.parse(JSON.stringify(msg)));
      } catch {
        // drop
      }
    }
  }

  private async handle(msg: ClientMessage): Promise<void> {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (msg.type.startsWith('editor.') || msg.type.startsWith('agent.')) {
      const m = msg as EditorClientMessage;
      try {
        const result = await this.handleEditor(m);
        this.send({ type: 'reply', id: m.id, ok: true, result });
      } catch (err) {
        const error: ErrorInfo = toErrorInfo(err);
        this.send({ type: 'reply', id: m.id, ok: false, error });
      }
      return;
    }
    await this.base.handle(msg as BaseClientMessage);
  }

  private host(): ProjectHost {
    const h = this.ctx.ws.current;
    if (!h) throw new AigeError('INVALID_STATE', 'No project is open.');
    return h;
  }

  private async handleEditor(m: EditorClientMessage): Promise<unknown> {
    switch (m.type) {
      case 'editor.info':
        return this.ctx.info();
      case 'editor.files':
        return this.ctx.ws.current ? await this.ctx.ws.current.fs.list('') : [];
      case 'editor.readText':
        return { path: m.path, content: await this.host().fs.read(m.path) };
      case 'editor.readBinary':
        return readBinaryFile(this.host(), m.path);
      case 'editor.scripts':
        return compileProjectScripts(this.host());
      case 'editor.thumbnail':
        return this.thumbnail(m.path, m.params ?? {});
      case 'editor.forgetRecent':
        this.ctx.state.forget(m.path);
        this.ctx.broadcastStatus();
        return this.ctx.info();
      case 'editor.ollamaModels':
        return listOllamaModels(m.baseURL);
      case 'agent.run':
        return this.ctx.agent.run(m.request);
      case 'agent.stop':
        this.ctx.agent.stop();
        return { stopped: true };
      case 'agent.reset':
        this.ctx.agent.reset();
        return { reset: true };
      case 'agent.state':
        return this.ctx.agent.snapshot();
      case 'agent.approve':
        this.ctx.agent.approve(m.requestId, m.approved);
        return { ok: true };
    }
  }

  /**
   * Model thumbnail: the same studio render as the model_preview tool (single iso view, 256 px),
   * but not saved to .aige/screenshots. Cached by model key (recipe source hash + params).
   */
  private async thumbnail(
    path: string,
    params: Record<string, unknown>,
  ): Promise<{ key: string; png: string }> {
    const host = this.host();
    const mp = modelPath(path);
    const key = await host.assets.modelKey(mp, params);
    const cached = thumbnailCache.get(key);
    if (cached) return { key, png: cached };
    const run = thumbnailQueue.then(() =>
      host.render.modelPreview(mp, params, { views: [{ kind: 'iso' }], size: 256, save: false }),
    );
    thumbnailQueue = run.catch(() => undefined);
    const { image } = await run;
    thumbnailCache.set(key, image.data);
    return { key, png: image.data };
  }

  dispose(): void {
    this.closed = true;
    this.base.dispose();
    try {
      this.port.close();
    } catch {
      // already closed
    }
  }
}

async function listOllamaModels(baseURL: string): Promise<{ models: string[] }> {
  let root: string;
  try {
    const u = new URL(baseURL);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    root = baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');
  } catch {
    throw new AigeError('INVALID_INPUT', `'${baseURL}' is not a valid http(s) URL.`);
  }
  try {
    const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { models?: { name?: string }[] };
    return {
      models: (json.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string'),
    };
  } catch (err) {
    throw new AigeError('IO_ERROR', `Cannot reach ${root} (${(err as Error).message}).`, {
      hint: 'Start Ollama (ollama serve) or check the server URL.',
    });
  }
}
