import {
  Agent,
  type AgentEvent,
  type AgentOptions,
  type ApprovalRequest,
  createProvider,
  defaultNeedsApproval,
  type ProviderConfig,
  type RunResult,
  type ToolHost,
} from '@aige/agent';
import { AigeError } from '@aige/core';
import { type Workspace, workspaceToolHost } from '@aige/host';
import type {
  AgentApprovalRequest,
  AgentProviderConfig,
  AgentRunRequest,
  AgentSnapshot,
  AgentUiEvent,
  ServerMessage,
} from '../shared/protocol.ts';

export interface Secrets {
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
}

const MAX_EVENTS = 3000;
const MAX_IMAGES_KEPT = 24;

/**
 * Runs the in-editor AI agent inside the host process. Tools go through the Workspace with
 * source 'agent'; each run is one bus transaction, so a whole AI turn undoes in one step.
 * Events are broadcast to every connected editor window and kept (compacted) so a reloaded
 * renderer can restore the conversation.
 */
export class AgentService {
  private agent: Agent | null = null;
  private agentKey = '';
  private abort: AbortController | null = null;
  private events: AgentUiEvent[] = [];
  private readonly approvals = new Map<
    string,
    { req: AgentApprovalRequest; resolve: (ok: boolean) => void }
  >();
  private selection: string | null = null;
  private secretsVersion = 0;
  private readonly ws: Workspace;
  private readonly broadcast: (msg: ServerMessage) => void;
  private secrets: Secrets = { anthropicApiKey: null, openaiApiKey: null };

  constructor(ws: Workspace, broadcast: (msg: ServerMessage) => void) {
    this.ws = ws;
    this.broadcast = broadcast;
  }

  setSecrets(s: Secrets): void {
    this.secrets = s;
    this.secretsVersion++;
  }

  get running(): boolean {
    return !!this.agent?.isRunning;
  }

  snapshot(): AgentSnapshot {
    return {
      running: this.running,
      events: this.events,
      approvals: [...this.approvals.values()].map((a) => a.req),
      plan: this.agent ? [...this.agent.plan] : [],
    };
  }

  async run(req: AgentRunRequest): Promise<RunResult> {
    if (this.running) {
      throw new AigeError('CONFLICT', 'The AI is already working on a request.', {
        hint: 'Wait for it or press Stop.',
      });
    }
    if (!req.text.trim()) throw new AigeError('INVALID_INPUT', 'Type a message first.');
    const agent = this.ensureAgent(req.provider, req.mode);
    agent.setMode(req.mode);
    this.selection = req.selection ?? null;
    this.push({ type: 'user', text: req.text });
    const abort = new AbortController();
    this.abort = abort;
    try {
      return await agent.run(req.text, { signal: abort.signal });
    } finally {
      if (this.abort === abort) this.abort = null;
      this.denyAllApprovals();
    }
  }

  stop(): void {
    this.abort?.abort();
    this.denyAllApprovals();
  }

  reset(): void {
    if (this.running) throw new AigeError('CONFLICT', 'Stop the AI before starting a new chat.');
    this.agent?.reset();
    this.events = [];
    this.broadcast({ type: 'agent.event', event: { type: 'reset' } });
  }

  approve(id: string, approved: boolean): void {
    const a = this.approvals.get(id);
    if (!a) return;
    this.approvals.delete(id);
    a.resolve(approved);
    this.broadcast({ type: 'agent.approvalDone', id });
  }

  private denyAllApprovals(): void {
    for (const id of [...this.approvals.keys()]) this.approve(id, false);
  }

  private ensureAgent(cfg: AgentProviderConfig, mode: AgentRunRequest['mode']): Agent {
    const key = `${JSON.stringify(cfg)}|${this.secretsVersion}`;
    if (this.agent && key === this.agentKey) return this.agent;
    let providerConfig: ProviderConfig;
    if (cfg.kind === 'anthropic') {
      const apiKey = this.secrets.anthropicApiKey ?? undefined;
      if (!apiKey && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        throw new AigeError('INVALID_STATE', 'No Anthropic API key is configured.', {
          hint: 'Open the AI settings (gear icon) and paste your API key, or pick a local Ollama model.',
        });
      }
      providerConfig = {
        kind: 'anthropic',
        model: cfg.model,
        ...(cfg.effort ? { effort: cfg.effort } : {}),
        ...(apiKey ? { apiKey } : {}),
      };
    } else {
      providerConfig = {
        kind: 'openai-compat',
        baseURL: cfg.baseURL,
        model: cfg.model,
        ...(this.secrets.openaiApiKey ? { apiKey: this.secrets.openaiApiKey } : {}),
      };
    }
    let provider: ReturnType<typeof createProvider>;
    try {
      provider = createProvider(providerConfig);
    } catch (err) {
      throw new AigeError('INVALID_STATE', `Could not start the AI provider: ${(err as Error).message}`, {
        hint: 'Check the API key / server URL in the AI settings.',
      });
    }
    const opts: AgentOptions = {
      provider,
      tools: this.toolHost(),
      mode,
      approve: (r) => this.requestApproval(r),
      // In the editor, screenshots/previews/play-tests run freely; only destructive edits ask first.
      needsApproval: (tool, input) => tool.kind === 'mutation' && defaultNeedsApproval(tool, input),
      onEvent: (e) => this.push(e),
    };
    // Keep the conversation when switching models or providers.
    this.agent = this.agent ? Agent.fromJSON(this.agent.toJSON(), opts) : new Agent(opts);
    this.agentKey = key;
    return this.agent;
  }

  private toolHost(): ToolHost {
    const base = workspaceToolHost(this.ws, 'agent');
    return {
      listTools: base.listTools,
      callTool: base.callTool,
      transaction: base.transaction,
      context: async () => {
        const ctx = await base.context();
        const sel = this.selection;
        const host = this.ws.current;
        if (!sel || !host) return ctx;
        const scene = host.state.scenes[host.state.activeScene];
        const e = scene?.entities.find((x) => x.id === sel);
        return e ? `${ctx}\nSelected in the editor: ${e.id} '${e.name}'` : ctx;
      },
    };
  }

  private requestApproval(r: ApprovalRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const req: AgentApprovalRequest = { id: r.id, name: r.name, input: r.input, reason: r.reason };
      this.approvals.set(r.id, { req, resolve });
      this.broadcast({ type: 'agent.approval', request: req });
    });
  }

  private push(e: AgentUiEvent): void {
    this.broadcast({ type: 'agent.event', event: e });
    // Compact the stored copy: merge streaming deltas, cap images and length.
    const last = this.events.at(-1);
    if (last && e.type === 'text' && last.type === 'text') {
      this.events[this.events.length - 1] = { type: 'text', delta: last.delta + e.delta };
      return;
    }
    if (last && e.type === 'thinking' && last.type === 'thinking') {
      this.events[this.events.length - 1] = { type: 'thinking', delta: last.delta + e.delta };
      return;
    }
    this.events.push(e);
    if (e.type === 'image') this.trimImages();
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  private trimImages(): void {
    let seen = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i] as AgentEvent;
      if (ev.type !== 'image') continue;
      if (++seen > MAX_IMAGES_KEPT && ev.image.data) {
        this.events[i] = { ...ev, image: { ...ev.image, data: '' } };
      }
    }
  }
}
