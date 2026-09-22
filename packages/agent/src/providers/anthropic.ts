/**
 * Claude provider (official @anthropic-ai/sdk, beta messages endpoint so refusal fallbacks and
 * context editing are available).
 *
 * Caching layout: tools (sorted, stable) -> system (frozen, explicit breakpoint) -> messages
 * (append-only; top-level automatic breakpoint moves forward each turn).
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaCacheControlEphemeral,
  BetaClearToolUses20250919Edit,
  BetaContentBlock,
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type {
  ChatEvent,
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ContentBlock,
  ProviderCaps,
  ProviderError,
  StopReason,
  ToolUseBlock,
  Usage,
} from '../types.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

export interface AnthropicModelProfile {
  /** adaptive: thinking {type:'adaptive'}; budget: {type:'enabled', budget_tokens}; always-on: omit the param. */
  thinking: 'adaptive' | 'budget' | 'always-on';
  /** Supports output_config.effort. */
  effort: boolean;
  /** Server-side refusal fallbacks are on by default for this model. */
  fallbacks: boolean;
  contextWindow: number;
  maxOutput: number;
}

export function anthropicModelProfile(model: string): AnthropicModelProfile {
  const id = model.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
  const big = { contextWindow: 1_000_000, maxOutput: 128_000 };
  switch (id) {
    case 'claude-opus-5':
    case 'claude-opus-5-5':
      return { thinking: 'adaptive', effort: true, fallbacks: true, ...big };
    case 'claude-fable-5-1':
      return { thinking: 'always-on', effort: true, fallbacks: true, ...big };
    case 'claude-fable-5':
      return { thinking: 'always-on', effort: true, fallbacks: false, ...big };
    case 'claude-sonnet-5':
      return { thinking: 'adaptive', effort: true, fallbacks: false, ...big };
    case 'claude-haiku-4-5':
      return {
        thinking: 'budget',
        effort: false,
        fallbacks: false,
        contextWindow: 200_000,
        maxOutput: 64_000,
      };
  }
  if (/^claude-(haiku|sonnet-4-5|sonnet-4-0|opus-4-5|opus-4-1|opus-4-0)/.test(id)) {
    return { thinking: 'budget', effort: false, fallbacks: false, contextWindow: 200_000, maxOutput: 64_000 };
  }
  // Opus 4.6+ / Sonnet 4.6 and unknown newer models: adaptive thinking with effort.
  return { thinking: 'adaptive', effort: true, fallbacks: false, ...big };
}

export type FallbacksConfig = 'default' | Array<{ model: string; max_tokens?: number }> | false;

export interface ContextEditingConfig {
  /** Clear old tool results once the prompt exceeds this many input tokens. Default 100k. */
  triggerTokens?: number;
  /** Most recent tool uses kept intact (screenshots included). Default 10. */
  keepToolUses?: number;
  /** Only clear when at least this many tokens can be removed (a clear invalidates the cache). Default 20k. */
  clearAtLeastTokens?: number;
  /** Tools whose results are never cleared. Default ['plan_update']. */
  excludeTools?: string[];
}

/** Resolved, request-shaping configuration (pure data; see buildAnthropicRequest). */
export interface AnthropicRequestConfig {
  model: string;
  effort: Effort;
  maxTokens: number;
  thinkingBudget: number;
  thinkingDisplay: 'summarized' | 'omitted';
  fallbacks: FallbacksConfig;
  contextEditing: Required<ContextEditingConfig> | false;
  cacheTtl: '5m' | '1h';
}

export interface AnthropicProviderOptions {
  model?: string;
  /** Defaults to ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth` profile (resolved by the SDK). */
  apiKey?: string;
  baseURL?: string;
  /** Pre-built client (tests, custom transports). */
  client?: Anthropic;
  /** Default 'high' (building games is agentic, multi-step work). Ignored by models without effort. */
  effort?: Effort;
  /** Default 64k (capped to the model's max output). Thinking counts toward it. */
  maxTokens?: number;
  /** budget_tokens for models that use manual thinking (Haiku 4.5). Default 12k. */
  thinkingBudget?: number;
  /** Default 'summarized' so the UI can show reasoning summaries. */
  thinkingDisplay?: 'summarized' | 'omitted';
  /** Server-side refusal fallbacks. Default 'default' for Opus 5 / Opus 5.5 / Fable 5.1, off otherwise. */
  fallbacks?: FallbacksConfig;
  /** Server-side clearing of old tool results (keeps old screenshots from piling up). Default on. */
  contextEditing?: ContextEditingConfig | false;
  cacheTtl?: '5m' | '1h';
  dangerouslyAllowBrowser?: boolean;
  maxRetries?: number;
}

export function resolveAnthropicConfig(opts: AnthropicProviderOptions = {}): AnthropicRequestConfig {
  const model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
  const profile = anthropicModelProfile(model);
  const maxTokens = Math.min(opts.maxTokens ?? 64_000, profile.maxOutput);
  const ce = opts.contextEditing;
  return {
    model,
    effort: opts.effort ?? 'high',
    maxTokens,
    thinkingBudget: opts.thinkingBudget ?? 12_000,
    thinkingDisplay: opts.thinkingDisplay ?? 'summarized',
    fallbacks: opts.fallbacks ?? (profile.fallbacks ? 'default' : false),
    contextEditing:
      ce === false
        ? false
        : {
            triggerTokens: ce?.triggerTokens ?? 100_000,
            keepToolUses: ce?.keepToolUses ?? 10,
            clearAtLeastTokens: ce?.clearAtLeastTokens ?? 20_000,
            excludeTools: ce?.excludeTools ?? ['plan_update'],
          },
    cacheTtl: opts.cacheTtl ?? '5m',
  };
}

export const BETA_CONTEXT_EDITING = 'context-management-2025-06-27';
/** Header for the `fallbacks: "default"` scalar form. */
export const BETA_FALLBACK_DEFAULT = 'server-side-fallback-2026-07-01';
/** Header for the `fallbacks: [{model}]` array form. */
export const BETA_FALLBACK_ARRAY = 'server-side-fallback-2026-06-01';

/** Builds the beta messages.stream() params. Pure: same inputs, byte-identical output. */
export function buildAnthropicRequest(
  cfg: AnthropicRequestConfig,
  req: ChatRequest,
): BetaMessageStreamParams {
  const profile = anthropicModelProfile(cfg.model);
  const cache: BetaCacheControlEphemeral =
    cfg.cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  const betas: string[] = [];
  const params: BetaMessageStreamParams = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    messages: toAnthropicMessages(req.messages),
    // Automatic caching: the breakpoint follows the growing conversation.
    cache_control: cache,
  };
  if (req.system) params.system = [{ type: 'text', text: req.system, cache_control: cache }];

  const tools = [...req.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (tools.length) {
    params.tools = tools.map(
      (t): BetaTool => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as BetaTool.InputSchema,
        // Stream large inputs (scripts, recipes) as generated; the engine validates every input.
        eager_input_streaming: true,
      }),
    );
    // Forced tool_choice is rejected on Opus 5.5 / Fable 5.1: always auto.
    params.tool_choice = { type: 'auto' };
  }

  if (profile.thinking === 'adaptive') {
    params.thinking = { type: 'adaptive', display: cfg.thinkingDisplay };
  } else if (profile.thinking === 'budget') {
    const budget = Math.max(1024, Math.min(cfg.thinkingBudget, cfg.maxTokens - 1024));
    params.thinking = { type: 'enabled', budget_tokens: budget };
  }
  if (profile.effort) params.output_config = { effort: cfg.effort };

  if (cfg.fallbacks === 'default') {
    params.fallbacks = 'default';
    betas.push(BETA_FALLBACK_DEFAULT);
  } else if (Array.isArray(cfg.fallbacks) && cfg.fallbacks.length) {
    params.fallbacks = cfg.fallbacks.map((f) => ({
      model: f.model,
      ...(f.max_tokens !== undefined ? { max_tokens: f.max_tokens } : {}),
    }));
    betas.push(BETA_FALLBACK_ARRAY);
  }

  if (cfg.contextEditing) {
    const ce = cfg.contextEditing;
    const edit: BetaClearToolUses20250919Edit = {
      type: 'clear_tool_uses_20250919',
      trigger: { type: 'input_tokens', value: ce.triggerTokens },
      keep: { type: 'tool_uses', value: ce.keepToolUses },
      clear_at_least: { type: 'input_tokens', value: ce.clearAtLeastTokens },
      ...(ce.excludeTools.length ? { exclude_tools: ce.excludeTools } : {}),
    };
    params.context_management = { edits: [edit] };
    betas.push(BETA_CONTEXT_EDITING);
  }
  if (betas.length) params.betas = betas;
  return params;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Canonical transcript -> Anthropic message params. Anthropic blocks round-trip unchanged. */
export function toAnthropicMessages(messages: ChatMessage[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.content) out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks: BetaContentBlockParam[] = [];
    for (const b of m.content) {
      const p = toParam(b);
      if (p) blocks.push(p);
    }
    if (blocks.length) out.push({ role: m.role, content: blocks });
  }
  return out;
}

function toParam(b: ContentBlock): BetaContentBlockParam | null {
  switch (b.type) {
    case 'text':
      return b.text ? { type: 'text', text: b.text } : null;
    case 'image':
      return imageParam(b);
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: isPlainObject(b.input) ? b.input : {} };
    case 'tool_result': {
      const content: Array<BetaTextBlockParam | BetaImageBlockParam> = [];
      for (const c of b.content) {
        if (c.type === 'text') {
          if (c.text) content.push({ type: 'text', text: c.text });
        } else content.push(imageParam(c));
      }
      const r: BetaToolResultBlockParam = { type: 'tool_result', tool_use_id: b.tool_use_id, content };
      if (b.is_error) r.is_error = true;
      return r;
    }
    case 'thinking':
      // Only signed (Anthropic-produced) thinking can be replayed.
      return b.signature ? { type: 'thinking', thinking: b.thinking, signature: b.signature } : null;
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: b.data };
    case 'opaque':
      return b.provider === 'anthropic' ? (b.block as BetaContentBlockParam) : null;
  }
}

function imageParam(b: Extract<ContentBlock, { type: 'image' }>): BetaImageBlockParam {
  return { type: 'image', source: { type: 'base64', media_type: b.source.media_type, data: b.source.data } };
}

/** Reads a tool_use block defensively: with eager input streaming the SDK parses lazily and can throw. */
export function readToolUse(b: BetaToolUseBlock): ToolUseBlock {
  const out: ToolUseBlock = { type: 'tool_use', id: b.id, name: b.name, input: {} };
  try {
    const input = b.input;
    if (isPlainObject(input)) out.input = input;
    else out.invalid = { raw: JSON.stringify(input) ?? '', error: 'Tool input must be a JSON object.' };
  } catch (err) {
    const raw = (b as unknown as { __json_buf?: string }).__json_buf ?? '';
    out.invalid = { raw, error: (err as Error).message };
  }
  return out;
}

const REPLAY_UNSAFE_BEFORE_FALLBACK = new Set([
  'thinking',
  'redacted_thinking',
  'tool_use',
  'server_tool_use',
]);

/**
 * Anthropic response content -> canonical blocks.
 * After a mid-output refusal fallback, thinking/tool_use blocks from the declined model (before the
 * last `fallback` block) must not be echoed back or executed; text is kept.
 */
export function normalizeAnthropicContent(content: BetaContentBlock[]): {
  blocks: ContentBlock[];
  notices: string[];
} {
  const blocks: ContentBlock[] = [];
  const notices: string[] = [];
  let lastFallback = -1;
  content.forEach((b, i) => {
    if (b.type === 'fallback') lastFallback = i;
  });
  content.forEach((b, i) => {
    if (i < lastFallback && REPLAY_UNSAFE_BEFORE_FALLBACK.has(b.type)) return;
    switch (b.type) {
      case 'text':
        blocks.push({ type: 'text', text: b.text });
        break;
      case 'thinking':
        blocks.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
        break;
      case 'redacted_thinking':
        blocks.push({ type: 'redacted_thinking', data: b.data });
        break;
      case 'tool_use':
        blocks.push(readToolUse(b));
        break;
      case 'fallback':
        // Audit marker; safe to drop from the echoed history.
        notices.push(`${b.from.model} declined this request; ${b.to.model} continued.`);
        break;
      default:
        blocks.push({ type: 'opaque', provider: 'anthropic', block: b });
    }
  });
  return { blocks, notices };
}

export function mapAnthropicStopReason(r: string | null | undefined): StopReason {
  switch (r) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'refusal':
    case 'pause_turn':
    case 'stop_sequence':
      return r;
    case 'model_context_window_exceeded':
      return 'context_window_exceeded';
    default:
      return 'other';
  }
}

export function anthropicUsage(u: BetaMessage['usage'] | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

export function anthropicError(err: unknown, signal?: AbortSignal): ProviderError {
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) {
    return { code: 'aborted', message: 'Request aborted.', retryable: false };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { code: 'network', message: err.message, retryable: true };
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const base = { message: err.message, ...(status !== undefined ? { status } : {}) };
    if (status === 401 || status === 403) return { code: 'auth', ...base, retryable: false };
    if (status === 429) return { code: 'rate_limit', ...base, retryable: true };
    if (status === 529 || status === 503) return { code: 'overloaded', ...base, retryable: true };
    if (status !== undefined && status >= 400 && status < 500)
      return { code: 'bad_request', ...base, retryable: false };
    return { code: 'unknown', ...base, retryable: status !== undefined && status >= 500 };
  }
  const message = err instanceof Error ? err.message : String(err);
  // With eager input streaming the SDK rejects when a tool input is not parseable JSON.
  if (err instanceof SyntaxError || /json/i.test(message)) {
    return { code: 'malformed_output', message, retryable: true };
  }
  return { code: 'unknown', message, retryable: false };
}

export class AnthropicProvider implements ChatProvider {
  readonly kind = 'anthropic';
  readonly id: string;
  readonly model: string;
  caps: ProviderCaps;
  readonly config: AnthropicRequestConfig;
  private readonly client: Anthropic;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.config = resolveAnthropicConfig(opts);
    this.model = this.config.model;
    this.id = `anthropic:${this.model}`;
    const profile = anthropicModelProfile(this.model);
    this.caps = {
      vision: true,
      imagesInToolResults: true,
      promptCache: true,
      contextWindow: profile.contextWindow,
      thinking: true,
    };
    this.client =
      opts.client ??
      new Anthropic({
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
        ...(opts.dangerouslyAllowBrowser ? { dangerouslyAllowBrowser: true } : {}),
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      });
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const params = buildAnthropicRequest(this.config, req);
    try {
      const stream = this.client.beta.messages.stream(params, signal ? { signal } : undefined);
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') yield { type: 'text_delta', text: ev.delta.text };
          else if (ev.delta.type === 'thinking_delta')
            yield { type: 'thinking_delta', text: ev.delta.thinking };
        } else if (ev.type === 'content_block_stop') {
          const block = stream.currentMessage?.content[ev.index];
          if (block?.type === 'tool_use') yield { type: 'tool_use', block: readToolUse(block) };
        }
      }
      const msg = await stream.finalMessage();
      const { blocks, notices } = normalizeAnthropicContent(msg.content);
      const stopReason = mapAnthropicStopReason(msg.stop_reason);
      const done: Extract<ChatEvent, { type: 'message_done' }> = {
        type: 'message_done',
        stopReason,
        content: blocks,
        usage: anthropicUsage(msg.usage),
        model: msg.model,
      };
      if (notices.length) done.notices = notices;
      if (stopReason === 'refusal' && msg.stop_details) {
        done.refusal = { category: msg.stop_details.category, explanation: msg.stop_details.explanation };
      }
      yield done;
    } catch (err) {
      yield { type: 'error', error: anthropicError(err, signal) };
    }
  }
}
