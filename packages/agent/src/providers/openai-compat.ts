/**
 * OpenAI-compatible chat-completions provider for local models (Ollama, LM Studio, vLLM, llama.cpp).
 *
 * - Streams chat completions with native function calling.
 * - Falls back to parsing tool calls written as text (`<tool_call>{...}</tool_call>` or a bare JSON
 *   object) and, for models without native tool support, to a text tool protocol.
 * - OpenAI `tool` messages cannot carry images, so image tool results are sent as a synthetic `user`
 *   message with data-URL parts right after the tool messages (vision models only).
 */
import OpenAI from 'openai';
import { textToolInstructions } from '../prompts.ts';
import { compactJson } from '../results.ts';
import type {
  ChatEvent,
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ContentBlock,
  ImageBlock,
  ProviderCaps,
  ProviderError,
  StopReason,
  ToolSpec,
  ToolUseBlock,
} from '../types.ts';

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

type OAMessage = OpenAI.ChatCompletionMessageParam;
type OAUserPart = OpenAI.ChatCompletionContentPart;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const newCallId = (): string => `call_${Math.random().toString(36).slice(2, 12)}`;

// ------------------------------------------------------------------ transcript translation

export interface OpenAITranslateOptions {
  /** The model can see images. Without vision, images become text placeholders. */
  vision: boolean;
  /** Keep only this many most recent images; older ones become placeholders. */
  maxImages?: number;
  /** Text tool protocol: tool calls/results are written as text instead of tool_calls/tool messages. */
  textTools?: boolean;
}

/** All image blocks in user content (including inside tool results), oldest first. */
function collectImages(messages: ChatMessage[]): ImageBlock[] {
  const out: ImageBlock[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string' || m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type === 'image') out.push(b);
      else if (b.type === 'tool_result') for (const c of b.content) if (c.type === 'image') out.push(c);
    }
  }
  return out;
}

const dataUrl = (img: ImageBlock): string => `data:${img.source.media_type};base64,${img.source.data}`;

/** Canonical transcript -> OpenAI chat messages. */
export function toOpenAIMessages(
  system: string,
  messages: ChatMessage[],
  opts: OpenAITranslateOptions,
): OAMessage[] {
  const out: OAMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  const all = collectImages(messages);
  const limit = opts.vision ? (opts.maxImages ?? Number.POSITIVE_INFINITY) : 0;
  const keep = new Set(limit >= all.length ? all : all.slice(all.length - limit));
  const placeholder = (img: ImageBlock): string =>
    `[image${img.label ? ` '${img.label}'` : ''} ${opts.vision ? 'omitted to save context' : 'not shown: this model cannot see images'}]`;
  const toolNames = new Map<string, string>();

  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(
        m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content },
      );
      continue;
    }
    if (m.role === 'assistant') {
      let text = '';
      const calls: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];
      for (const b of m.content) {
        if (b.type === 'text') text += (text ? '\n' : '') + b.text;
        else if (b.type === 'tool_use') {
          toolNames.set(b.id, b.name);
          const args = isPlainObject(b.input) ? b.input : {};
          if (opts.textTools) {
            text += `${text ? '\n' : ''}<tool_call>${JSON.stringify({ name: b.name, arguments: args })}</tool_call>`;
          } else {
            calls.push({
              id: b.id,
              type: 'function',
              function: { name: b.name, arguments: JSON.stringify(args) },
            });
          }
        }
        // thinking / redacted / opaque blocks are not replayed to OpenAI-compatible servers
      }
      const msg: OpenAI.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: text || (calls.length ? null : ''),
      };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }

    // user message
    const toolMsgs: OAMessage[] = [];
    const toolTextParts: OAUserPart[] = [];
    const toolImageParts: OAUserPart[] = [];
    const parts: OAUserPart[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const name = toolNames.get(b.tool_use_id) ?? 'tool';
        let text = b.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        if (b.is_error) text = `Error: ${text}`;
        for (const c of b.content) {
          if (c.type !== 'image') continue;
          if (keep.has(c)) {
            text += `\n[image${c.label ? ` '${c.label}'` : ''} attached in the next message]`;
            toolImageParts.push({ type: 'text', text: `Image from ${name}${c.label ? `: ${c.label}` : ''}` });
            toolImageParts.push({ type: 'image_url', image_url: { url: dataUrl(c) } });
          } else text += `\n${placeholder(c)}`;
        }
        if (opts.textTools) {
          toolTextParts.push({
            type: 'text',
            text: `[tool_result id=${b.tool_use_id} name=${name}]\n${text || 'OK'}`,
          });
        } else toolMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: text || 'OK' });
      } else if (b.type === 'text') {
        if (b.text) parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image') {
        parts.push(
          keep.has(b)
            ? { type: 'image_url', image_url: { url: dataUrl(b) } }
            : { type: 'text', text: placeholder(b) },
        );
      }
    }
    out.push(...toolMsgs);
    if (opts.textTools) {
      // one user message: tool results, their images, then any other content
      pushUser(out, [...toolTextParts, ...toolImageParts, ...parts]);
    } else {
      if (toolImageParts.length) {
        pushUser(out, [
          { type: 'text', text: 'Images returned by the tool calls above:' },
          ...toolImageParts,
        ]);
      }
      pushUser(out, parts);
    }
  }
  return out;
}

function pushUser(out: OAMessage[], parts: OAUserPart[]): void {
  if (!parts.length) return;
  if (parts.every((p) => p.type === 'text')) {
    out.push({
      role: 'user',
      content: parts.map((p) => (p as OpenAI.ChatCompletionContentPartText).text).join('\n\n'),
    });
  } else out.push({ role: 'user', content: parts });
}

// ------------------------------------------------------------------ text tool calls

export interface TextToolCall {
  name: string;
  input: Record<string, unknown>;
  raw: string;
  /** Set when the call was recognised but its JSON was malformed. */
  error?: string;
}

const stripFences = (s: string): string =>
  s
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();

function callFromObject(v: unknown, raw: string): TextToolCall | null {
  if (!isPlainObject(v)) return null;
  const fn = isPlainObject(v.function) ? v.function : v;
  if (typeof fn.name !== 'string' || !fn.name) return null;
  let args: unknown = fn.arguments ?? fn.parameters ?? fn.input ?? {};
  if (typeof args === 'string') {
    try {
      args = args.trim() ? JSON.parse(args) : {};
    } catch (err) {
      return {
        name: fn.name,
        input: {},
        raw,
        error: `"arguments" is not valid JSON: ${(err as Error).message}`,
      };
    }
  }
  if (!isPlainObject(args))
    return { name: fn.name, input: {}, raw, error: '"arguments" must be a JSON object.' };
  return { name: fn.name, input: args, raw };
}

function parseTaggedCall(body: string): TextToolCall {
  const raw = body.trim();
  const cleaned = stripFences(raw);
  try {
    const v = JSON.parse(cleaned);
    return (
      callFromObject(v, raw) ?? {
        name: isPlainObject(v) && typeof v.name === 'string' ? v.name : 'unknown',
        input: {},
        raw,
        error: 'Expected {"name": "tool_name", "arguments": {...}}.',
      }
    );
  } catch (err) {
    const name = /"name"\s*:\s*"([^"]+)"/.exec(cleaned)?.[1] ?? 'unknown';
    return { name, input: {}, raw, error: `Invalid JSON: ${(err as Error).message}` };
  }
}

/**
 * Finds tool calls a model wrote as text: `<tool_call>{"name":...,"arguments":{...}}</tool_call>`
 * (any number, closing tag optional at the end) or a reply that is only a JSON object/array with
 * name + arguments (accepted only when every name is a known tool, to avoid false positives).
 */
export function parseTextToolCalls(
  text: string,
  toolNames?: ReadonlySet<string>,
): { text: string; calls: TextToolCall[] } {
  if (text.includes('<tool_call>')) {
    const calls: TextToolCall[] = [];
    const rest = text.replace(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g, (_m, body: string) => {
      calls.push(parseTaggedCall(body));
      return '';
    });
    return { text: rest.replace(/<\/tool_call>/g, '').trim(), calls };
  }
  const trimmed = stripFences(text.trim());
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const v: unknown = JSON.parse(trimmed);
      const arr = Array.isArray(v) ? v : [v];
      const calls = arr.map((x) => callFromObject(x, trimmed));
      if (
        calls.length > 0 &&
        calls.every((c): c is TextToolCall => c !== null && !c.error) &&
        (!toolNames || calls.every((c) => toolNames.has(c.name)))
      ) {
        return { text: '', calls };
      }
    } catch {
      // not JSON: plain text answer
    }
  }
  return { text, calls: [] };
}

/** Splits `<think>...</think>` (also a dangling `</think>` whose opening tag the server stripped). */
export function extractThinking(text: string): { thinking: string; text: string } {
  const thoughts: string[] = [];
  let rest = text;
  if (!rest.includes('<think>') && rest.includes('</think>')) {
    const i = rest.indexOf('</think>');
    thoughts.push(rest.slice(0, i));
    rest = rest.slice(i + '</think>'.length);
  }
  rest = rest.replace(/<think>([\s\S]*?)(?:<\/think>|$)/g, (_m, t: string) => {
    thoughts.push(t);
    return '';
  });
  return {
    thinking: thoughts
      .map((t) => t.trim())
      .filter(Boolean)
      .join('\n'),
    text: rest.trim(),
  };
}

/**
 * Routes streamed text deltas: `<think>` content to thinking, text after `<tool_call>` suppressed
 * (the calls surface as tool_use blocks at the end). Holds back partial tags across chunks.
 */
export class TagRouter {
  private buf = '';
  private mode: 'text' | 'think' | 'tool' = 'text';

  push(delta: string): Array<{ kind: 'text' | 'thinking'; text: string }> {
    const out: Array<{ kind: 'text' | 'thinking'; text: string }> = [];
    this.buf += delta;
    const emit = (s: string) => {
      if (s && this.mode !== 'tool') out.push({ kind: this.mode === 'think' ? 'thinking' : 'text', text: s });
    };
    for (;;) {
      if (this.mode === 'tool') {
        this.buf = '';
        return out;
      }
      const tags = this.mode === 'text' ? ['<think>', '<tool_call>'] : ['</think>'];
      let idx = -1;
      let tag = '';
      for (const t of tags) {
        const i = this.buf.indexOf(t);
        if (i >= 0 && (idx < 0 || i < idx)) {
          idx = i;
          tag = t;
        }
      }
      if (idx >= 0) {
        emit(this.buf.slice(0, idx));
        this.buf = this.buf.slice(idx + tag.length);
        this.mode = tag === '<think>' ? 'think' : tag === '</think>' ? 'text' : 'tool';
        continue;
      }
      // hold back a suffix that could be the start of a tag
      let hold = 0;
      for (const t of tags) {
        for (let n = Math.min(t.length - 1, this.buf.length); n > hold; n--) {
          if (this.buf.endsWith(t.slice(0, n))) {
            hold = n;
            break;
          }
        }
      }
      emit(this.buf.slice(0, this.buf.length - hold));
      this.buf = this.buf.slice(this.buf.length - hold);
      return out;
    }
  }

  flush(): Array<{ kind: 'text' | 'thinking'; text: string }> {
    const s = this.buf;
    this.buf = '';
    if (!s || this.mode === 'tool') return [];
    return [{ kind: this.mode === 'think' ? 'thinking' : 'text', text: s }];
  }
}

// ------------------------------------------------------------------ capability detection

export interface DetectedCapabilities {
  source: 'ollama' | 'lmstudio' | 'none';
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  /** The model's trained context length (the server may run with a smaller window). */
  contextLength?: number;
  capabilities: string[];
  error?: string;
}

export interface DetectOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Server root for an OpenAI-compatible base URL ('http://localhost:11434/v1' -> 'http://localhost:11434'). */
export const serverRoot = (baseURL: string): string => baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');

/**
 * Asks Ollama (`POST /api/show`) what a model can do: capabilities ["completion","tools","vision",
 * "thinking"] and the context length from model_info. Falls back to LM Studio's `/api/v0/models/:id`.
 * Never throws.
 */
export async function detectOllamaCapabilities(
  baseURL: string,
  model: string,
  opts: DetectOptions = {},
): Promise<DetectedCapabilities> {
  const f = opts.fetch ?? globalThis.fetch;
  const root = serverRoot(baseURL);
  const init = (extra: RequestInit = {}): RequestInit =>
    opts.signal ? { ...extra, signal: opts.signal } : extra;
  let reason = 'no capability endpoint answered';
  try {
    const res = await f(
      `${root}/api/show`,
      init({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      }),
    );
    if (res.ok) {
      const j = (await res.json()) as {
        capabilities?: string[];
        model_info?: Record<string, unknown>;
        projector_info?: unknown;
      };
      const caps = Array.isArray(j.capabilities) ? j.capabilities : [];
      const info = j.model_info ?? {};
      const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'));
      const ctx = ctxKey ? Number(info[ctxKey]) : Number.NaN;
      const out: DetectedCapabilities = {
        source: 'ollama',
        // Older servers do not report capabilities: assume tools.
        tools: caps.length === 0 || caps.includes('tools'),
        vision: caps.includes('vision') || !!j.projector_info,
        thinking: caps.includes('thinking'),
        capabilities: caps,
      };
      if (Number.isFinite(ctx) && ctx > 0) out.contextLength = ctx;
      return out;
    }
    if (res.status === 404) {
      reason = `model '${model}' not found on the Ollama server`;
      try {
        const tags = await f(`${root}/api/tags`, init());
        if (tags.ok) {
          const list = ((await tags.json()) as { models?: Array<{ name?: string }> }).models ?? [];
          const names = list.map((m) => m.name).filter(Boolean);
          if (names.length) reason += ` (installed: ${names.slice(0, 12).join(', ')})`;
        }
      } catch {
        // ignore
      }
      return {
        source: 'ollama',
        tools: true,
        vision: false,
        thinking: false,
        capabilities: [],
        error: reason,
      };
    }
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    reason = (err as Error).message;
  }
  try {
    const res = await f(`${root}/api/v0/models/${encodeURIComponent(model)}`, init());
    if (res.ok) {
      const j = (await res.json()) as { type?: string; capabilities?: string[]; max_context_length?: number };
      const caps = Array.isArray(j.capabilities) ? j.capabilities : [];
      const out: DetectedCapabilities = {
        source: 'lmstudio',
        tools: caps.length === 0 || caps.includes('tool_use'),
        vision: j.type === 'vlm',
        thinking: false,
        capabilities: caps,
      };
      if (typeof j.max_context_length === 'number') out.contextLength = j.max_context_length;
      return out;
    }
  } catch (err) {
    if (opts.signal?.aborted) throw err;
  }
  return {
    source: 'none',
    tools: true,
    vision: false,
    thinking: false,
    capabilities: [],
    error: `Capability detection failed (${reason}); assuming tool support without vision.`,
  };
}

// ------------------------------------------------------------------ provider

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface OpenAICompatProviderOptions {
  model: string;
  /** Default http://localhost:11434/v1 (Ollama). LM Studio: http://localhost:1234/v1. */
  baseURL?: string;
  /** Default 'ollama' (local servers ignore it). */
  apiKey?: string;
  /** Default 0.3. */
  temperature?: number;
  maxTokens?: number;
  /** Passed as reasoning_effort for thinking models ('none' turns thinking off on Ollama). */
  reasoningEffort?: ReasoningEffort;
  /** Explicit capabilities; they win over detection. */
  caps?: Partial<ProviderCaps>;
  /** Detect capabilities via the server's native API on first use. Default true. */
  detect?: boolean;
  /** native: tools/tool_calls; text: tool protocol in the prompt; auto: native unless the model lacks tools. */
  toolMode?: 'auto' | 'native' | 'text';
  client?: OpenAI;
  fetch?: typeof fetch;
  dangerouslyAllowBrowser?: boolean;
  timeoutMs?: number;
}

function toolCatalog(tools: ToolSpec[]): string {
  return tools
    .map(
      (t) =>
        `- ${t.name}: ${t.description.replace(/\s+/g, ' ')}\n  arguments schema: ${compactJson(t.input_schema, 1500)}`,
    )
    .join('\n');
}

export function openAIError(err: unknown, signal: AbortSignal | undefined, baseURL: string): ProviderError {
  if (signal?.aborted || err instanceof OpenAI.APIUserAbortError) {
    return { code: 'aborted', message: 'Request aborted.', retryable: false };
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return {
      code: 'network',
      message: `Cannot reach ${baseURL} (${err.message}). Is the local model server (e.g. Ollama) running?`,
      retryable: true,
    };
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const base = { message: err.message, ...(status !== undefined ? { status } : {}) };
    if (status === 401 || status === 403) return { code: 'auth', ...base, retryable: false };
    if (status === 429) return { code: 'rate_limit', ...base, retryable: true };
    if (status === 503) return { code: 'overloaded', ...base, retryable: true };
    if (status !== undefined && status >= 400 && status < 500)
      return { code: 'bad_request', ...base, retryable: false };
    return { code: 'unknown', ...base, retryable: status !== undefined && status >= 500 };
  }
  return { code: 'unknown', message: err instanceof Error ? err.message : String(err), retryable: false };
}

const isNoToolsError = (err: unknown): boolean =>
  err instanceof OpenAI.APIError && /does not support tools/i.test(err.message);

export class OpenAICompatProvider implements ChatProvider {
  readonly kind = 'openai-compat';
  readonly id: string;
  readonly model: string;
  readonly baseURL: string;
  caps: ProviderCaps;
  /** Result of capability detection (after prepare()). */
  detected?: DetectedCapabilities;
  toolMode: 'native' | 'text';
  private readonly opts: OpenAICompatProviderOptions;
  private readonly client: OpenAI;
  private prepared = false;

  constructor(opts: OpenAICompatProviderOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.baseURL = opts.baseURL ?? DEFAULT_OLLAMA_BASE_URL;
    this.id = `openai-compat:${this.model}`;
    this.caps = {
      vision: false,
      imagesInToolResults: false,
      promptCache: false,
      contextWindow: 32_768,
      thinking: false,
      ...opts.caps,
    };
    this.toolMode = opts.toolMode === 'text' ? 'text' : 'native';
    this.client =
      opts.client ??
      new OpenAI({
        baseURL: this.baseURL,
        apiKey: opts.apiKey ?? 'ollama',
        ...(opts.dangerouslyAllowBrowser ? { dangerouslyAllowBrowser: true } : {}),
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
      });
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    if (this.prepared) return;
    this.prepared = true;
    if (this.opts.detect === false) return;
    const d = await detectOllamaCapabilities(this.baseURL, this.model, {
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(signal ? { signal } : {}),
    });
    this.detected = d;
    if (d.source === 'none' || d.error) return;
    const explicit = this.opts.caps ?? {};
    this.caps = {
      ...this.caps,
      vision: explicit.vision ?? d.vision,
      thinking: explicit.thinking ?? d.thinking,
      contextWindow: explicit.contextWindow ?? d.contextLength ?? this.caps.contextWindow,
    };
    if ((this.opts.toolMode ?? 'auto') === 'auto') this.toolMode = d.tools ? 'native' : 'text';
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    if (!this.prepared) {
      try {
        await this.prepare(signal);
      } catch (err) {
        yield { type: 'error', error: openAIError(err, signal, this.baseURL) };
        return;
      }
    }
    const textTools = this.toolMode === 'text' && req.tools.length > 0;
    const system = textTools ? req.system + textToolInstructions(toolCatalog(req.tools)) : req.system;
    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: toOpenAIMessages(system, req.messages, {
        vision: this.caps.vision,
        textTools,
        ...(req.maxImages !== undefined ? { maxImages: req.maxImages } : {}),
      }),
      stream: true,
      stream_options: { include_usage: true },
      temperature: this.opts.temperature ?? 0.3,
    };
    if (!textTools && req.tools.length) {
      params.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }
    if (this.opts.maxTokens) params.max_tokens = this.opts.maxTokens;
    if (this.opts.reasoningEffort) params.reasoning_effort = this.opts.reasoningEffort;

    let stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(params, signal ? { signal } : undefined);
    } catch (err) {
      if (!textTools && req.tools.length && isNoToolsError(err)) {
        // The model has no native tool support: switch to the text protocol and retry.
        this.toolMode = 'text';
        yield* this.stream(req, signal);
        return;
      }
      yield { type: 'error', error: openAIError(err, signal, this.baseURL) };
      return;
    }

    const router = new TagRouter();
    let text = '';
    let reasoning = '';
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let usage: OpenAI.CompletionUsage | undefined;
    try {
      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices[0];
        if (!choice) continue;
        const d = choice.delta as OpenAI.ChatCompletionChunk.Choice.Delta & {
          reasoning?: string | null;
          reasoning_content?: string | null;
        };
        const r = d.reasoning_content ?? d.reasoning;
        if (typeof r === 'string' && r) {
          reasoning += r;
          yield { type: 'thinking_delta', text: r };
        }
        if (typeof d.content === 'string' && d.content) {
          text += d.content;
          for (const p of router.push(d.content)) {
            yield p.kind === 'text'
              ? { type: 'text_delta', text: p.text }
              : { type: 'thinking_delta', text: p.text };
          }
        }
        for (const tc of d.tool_calls ?? []) {
          const acc = calls.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          calls.set(tc.index, acc);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      for (const p of router.flush()) {
        yield p.kind === 'text'
          ? { type: 'text_delta', text: p.text }
          : { type: 'thinking_delta', text: p.text };
      }
    } catch (err) {
      yield { type: 'error', error: openAIError(err, signal, this.baseURL) };
      return;
    }

    const content: ContentBlock[] = [];
    const split = extractThinking(text);
    const thinking = [reasoning.trim(), split.thinking].filter(Boolean).join('\n');
    if (thinking) content.push({ type: 'thinking', thinking });
    let visible = split.text;
    const toolUses: ToolUseBlock[] = [];
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      const block: ToolUseBlock = {
        type: 'tool_use',
        id: c.id || newCallId(),
        name: c.name || 'unknown',
        input: {},
      };
      if (c.args.trim()) {
        try {
          const v: unknown = JSON.parse(c.args);
          if (isPlainObject(v)) block.input = v;
          else block.invalid = { raw: c.args, error: 'Tool arguments must be a JSON object.' };
        } catch (err) {
          block.invalid = { raw: c.args, error: `Invalid JSON: ${(err as Error).message}` };
        }
      }
      toolUses.push(block);
    }
    if (toolUses.length === 0) {
      const parsed = parseTextToolCalls(visible, new Set(req.tools.map((t) => t.name)));
      if (parsed.calls.length) {
        visible = parsed.text;
        for (const c of parsed.calls) {
          const block: ToolUseBlock = { type: 'tool_use', id: newCallId(), name: c.name, input: c.input };
          if (c.error) block.invalid = { raw: c.raw, error: c.error };
          toolUses.push(block);
        }
      }
    }
    if (visible) content.push({ type: 'text', text: visible });
    content.push(...toolUses);
    for (const t of toolUses) yield { type: 'tool_use', block: t };

    const stopReason: StopReason =
      finish === 'length'
        ? 'max_tokens'
        : toolUses.length
          ? 'tool_use'
          : finish === 'content_filter'
            ? 'refusal'
            : 'end_turn';
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    yield {
      type: 'message_done',
      stopReason,
      content,
      usage: {
        inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
        outputTokens: usage?.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
      model: this.model,
    };
  }
}
