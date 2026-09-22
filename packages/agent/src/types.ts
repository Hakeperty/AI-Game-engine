/**
 * Shared types for the AIGE agent: the ToolHost the engine implements, the canonical
 * (Anthropic-style) transcript, and the provider abstraction.
 */

// ------------------------------------------------------------------ tool host (engine side)

export type ToolKind = 'mutation' | 'query' | 'action';
export type ToolTier = 'core' | 'extended';

/** A tool as the engine describes it. `toolDefinitions(bus.list())` from @aige/core has this shape. */
export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  kind: ToolKind;
  tier: ToolTier;
  group?: string;
}

export interface ToolCallError {
  code: string;
  message: string;
  hint?: string;
}

/** Same shape as `CommandBus.call()`. A successful result may carry `images: ImageRef[]` at the top level. */
export interface ToolCallResult {
  ok: boolean;
  result?: unknown;
  error?: ToolCallError;
}

/** What the agent needs from the engine. The editor/host implements it on top of the CommandBus. */
export interface ToolHost {
  listTools(): AgentTool[] | Promise<AgentTool[]>;
  callTool(name: string, input: unknown, opts?: { signal?: AbortSignal }): Promise<ToolCallResult>;
  /** Groups every mutation made inside `fn` into one undo step (one agent request). */
  transaction?<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /** Short scene outline + selection. Injected into each user turn (never into the system prompt). */
  context?(): Promise<string>;
}

/** Image returned by a tool (same shape as ImageRef in @aige/core). */
export interface ToolImage {
  mimeType: string;
  /** base64, no data: prefix */
  data: string;
  label?: string;
  path?: string;
  width?: number;
  height?: number;
}

// ------------------------------------------------------------------ canonical transcript

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: ImageMediaType; data: string };
  /** Not sent to Anthropic; used for "[image omitted: label]" placeholders. */
  label?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  /** Set when the model's arguments could not be parsed; the tool is not run and the error is fed back. */
  invalid?: { raw: string; error: string };
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: Array<TextBlock | ImageBlock>;
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  /** Present on Anthropic thinking blocks; they must be passed back unchanged. */
  signature?: string;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

/** A provider-specific block kept verbatim (only the provider that produced it sends it back). */
export interface OpaqueBlock {
  type: 'opaque';
  provider: string;
  block: unknown;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | OpaqueBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

// ------------------------------------------------------------------ providers

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'refusal'
  | 'pause_turn'
  | 'stop_sequence'
  | 'context_window_exceeded'
  | 'other';

export interface Usage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProviderCaps {
  vision: boolean;
  imagesInToolResults: boolean;
  promptCache: boolean;
  contextWindow: number;
  thinking: boolean;
}

/** Tool definition as sent to a provider. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface ChatRequest {
  /** Frozen for the whole session (prompt caching). */
  system: string;
  /** Sorted by name and stable for the whole session. */
  tools: ToolSpec[];
  messages: ChatMessage[];
  /** Providers that rewrite the outgoing transcript (OpenAI-compatible) keep only this many recent images. */
  maxImages?: number;
}

export type ProviderErrorCode =
  | 'aborted'
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'bad_request'
  | 'network'
  | 'malformed_output'
  | 'unknown';

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  status?: number;
  retryable: boolean;
}

export interface RefusalInfo {
  category?: string | null;
  explanation?: string | null;
}

export type ChatEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  /** A complete tool call (informational; the authoritative list is in message_done.content). */
  | { type: 'tool_use'; block: ToolUseBlock }
  | {
      type: 'message_done';
      stopReason: StopReason;
      /** The full assistant content to append to the transcript. */
      content: ContentBlock[];
      usage: Usage;
      /** Model that actually produced the message (differs from the requested one after a fallback). */
      model?: string;
      refusal?: RefusalInfo;
      notices?: string[];
    }
  | { type: 'error'; error: ProviderError };

export interface ChatProvider {
  /** e.g. 'anthropic:claude-opus-5' or 'openai-compat:qwen3.8:27b' */
  readonly id: string;
  readonly kind: string;
  readonly model: string;
  caps: ProviderCaps;
  /** Optional one-time setup (capability detection). Called by the agent before the first request. */
  prepare?(signal?: AbortSignal): Promise<void>;
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export const totalTokens = (u: Usage): number =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
