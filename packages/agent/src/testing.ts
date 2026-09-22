/**
 * Test doubles: a provider that replays scripted assistant turns and an in-memory ToolHost.
 * Exported so the editor/host can test their agent wiring without a network.
 */
import type {
  AgentTool,
  ChatEvent,
  ChatProvider,
  ChatRequest,
  ContentBlock,
  ProviderCaps,
  ProviderError,
  RefusalInfo,
  StopReason,
  ToolCallResult,
  ToolHost,
  ToolUseBlock,
  Usage,
} from './types.ts';

export interface MockTurn {
  /** Full assistant content. Alternatively use `text` / `toolCalls`. */
  content?: ContentBlock[];
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ name: string; input?: unknown; id?: string }>;
  /** Default: 'tool_use' when the turn has tool calls, else 'end_turn'. */
  stopReason?: StopReason;
  usage?: Partial<Usage>;
  model?: string;
  refusal?: RefusalInfo;
  notices?: string[];
  /** Emit this provider error instead of a message. */
  error?: ProviderError;
  /** Block until the request's AbortSignal fires (cancellation tests). */
  hang?: boolean;
}

export interface MockProviderOptions {
  model?: string;
  /** Default 'mock'. Use 'openai-compat' to exercise small-model defaults. */
  kind?: string;
  caps?: Partial<ProviderCaps>;
}

export class MockProvider implements ChatProvider {
  readonly id: string;
  readonly kind: string;
  readonly model: string;
  caps: ProviderCaps;
  /** Snapshot of every request received. */
  readonly requests: ChatRequest[] = [];
  private readonly script: MockTurn[] | ((req: ChatRequest, index: number) => MockTurn | undefined);
  private index = 0;

  constructor(
    script: MockTurn[] | ((req: ChatRequest, index: number) => MockTurn | undefined),
    opts: MockProviderOptions = {},
  ) {
    this.script = script;
    this.model = opts.model ?? 'mock-model';
    this.kind = opts.kind ?? 'mock';
    this.id = `${this.kind}:${this.model}`;
    this.caps = {
      vision: true,
      imagesInToolResults: true,
      promptCache: false,
      contextWindow: 200_000,
      thinking: false,
      ...opts.caps,
    };
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    this.requests.push(structuredClone(req));
    const i = this.index++;
    const turn = typeof this.script === 'function' ? this.script(req, i) : this.script[i];
    if (!turn) {
      yield {
        type: 'error',
        error: { code: 'unknown', message: `MockProvider: no scripted turn #${i}`, retryable: false },
      };
      return;
    }
    if (turn.error) {
      yield { type: 'error', error: turn.error };
      return;
    }
    if (turn.hang) {
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'error', error: { code: 'aborted', message: 'Request aborted.', retryable: false } };
      return;
    }
    const content: ContentBlock[] = turn.content ?? [
      ...(turn.thinking ? [{ type: 'thinking' as const, thinking: turn.thinking }] : []),
      ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
      ...(turn.toolCalls ?? []).map(
        (c, k): ToolUseBlock => ({
          type: 'tool_use',
          id: c.id ?? `toolu_${i}_${k}`,
          name: c.name,
          input: c.input ?? {},
        }),
      ),
    ];
    for (const b of content) {
      if (signal?.aborted) {
        yield { type: 'error', error: { code: 'aborted', message: 'Request aborted.', retryable: false } };
        return;
      }
      if (b.type === 'text') yield { type: 'text_delta', text: b.text };
      else if (b.type === 'thinking') yield { type: 'thinking_delta', text: b.thinking };
      else if (b.type === 'tool_use') yield { type: 'tool_use', block: b };
    }
    const hasTools = content.some((b) => b.type === 'tool_use');
    const done: Extract<ChatEvent, { type: 'message_done' }> = {
      type: 'message_done',
      stopReason: turn.stopReason ?? (hasTools ? 'tool_use' : 'end_turn'),
      content,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, ...turn.usage },
      model: turn.model ?? this.model,
    };
    if (turn.refusal) done.refusal = turn.refusal;
    if (turn.notices) done.notices = turn.notices;
    yield done;
  }
}

export interface FakeToolDef extends Partial<Omit<AgentTool, 'name'>> {
  name: string;
  /** Return value becomes the result; throwing (optionally with .code/.hint) becomes an error result. */
  handler?: (input: any) => unknown;
}

export class FakeToolHost implements ToolHost {
  readonly calls: Array<{ name: string; input: unknown }> = [];
  readonly transactions: string[] = [];
  contextText = '';
  private readonly defs: FakeToolDef[];

  constructor(defs: FakeToolDef[], opts: { context?: string } = {}) {
    this.defs = defs;
    if (opts.context) this.contextText = opts.context;
  }

  listTools(): AgentTool[] {
    return this.defs.map((d) => ({
      name: d.name,
      description: d.description ?? `The ${d.name} tool.`,
      input_schema: d.input_schema ?? { type: 'object', properties: {} },
      kind: d.kind ?? 'query',
      tier: d.tier ?? 'core',
      group: d.group ?? 'test',
    }));
  }

  async callTool(name: string, input: unknown): Promise<ToolCallResult> {
    this.calls.push({ name, input });
    const def = this.defs.find((d) => d.name === name);
    if (!def) return { ok: false, error: { code: 'UNKNOWN_COMMAND', message: `Unknown tool '${name}'.` } };
    try {
      return { ok: true, result: await def.handler?.(input) };
    } catch (err) {
      const e = err as { code?: string; message?: string; hint?: string };
      return {
        ok: false,
        error: {
          code: e.code ?? 'INTERNAL',
          message: e.message ?? String(err),
          ...(e.hint ? { hint: e.hint } : {}),
        },
      };
    }
  }

  async transaction<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.transactions.push(label);
    return fn();
  }

  async context(): Promise<string> {
    return this.contextText;
  }
}
