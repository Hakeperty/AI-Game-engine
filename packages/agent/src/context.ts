/**
 * Context management for small local models ("stateless steps"): when the transcript grows past a
 * token budget, the request carries only a condensed header (request, plan, progress summary, fresh
 * editor context) plus the last few turns verbatim. The stored history itself stays append-only.
 */
import type { ChatMessage, ContentBlock, TextBlock, ToolResultBlock } from './types.ts';

/** Rough cost of one image in tokens (base64 length says nothing about vision tokens). */
export const IMAGE_TOKEN_ESTIMATE = 1000;

/** Tags the agent wraps injected (non-user) text in. */
export const CONTEXT_TAG = 'editor_context';
export const PLAN_TAG = 'current_plan';

function blockChars(b: ContentBlock): { chars: number; images: number } {
  switch (b.type) {
    case 'text':
      return { chars: b.text.length, images: 0 };
    case 'image':
      return { chars: 0, images: 1 };
    case 'tool_use':
      return { chars: b.name.length + safeLen(b.input), images: 0 };
    case 'tool_result': {
      let chars = 0;
      let images = 0;
      for (const c of b.content) {
        if (c.type === 'text') chars += c.text.length;
        else images++;
      }
      return { chars, images };
    }
    case 'thinking':
      return { chars: b.thinking.length, images: 0 };
    case 'redacted_thinking':
      return { chars: b.data.length, images: 0 };
    case 'opaque':
      return { chars: safeLen(b.block), images: 0 };
  }
}

function safeLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Token estimate: characters / 4, images at a flat rate. */
export function estimateTokens(messages: readonly ChatMessage[], extraChars = 0): number {
  let chars = extraChars;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
      continue;
    }
    for (const b of m.content) {
      const r = blockChars(b);
      chars += r.chars;
      images += r.images;
    }
  }
  return Math.ceil(chars / 4) + images * IMAGE_TOKEN_ESTIMATE;
}

/** A human request (as opposed to a user message that only carries tool results). */
export function isRequestMessage(m: ChatMessage): boolean {
  if (m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  return !m.content.some((b) => b.type === 'tool_result');
}

export function lastRequestIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (isRequestMessage(messages[i]!)) return i;
  return -1;
}

/** The user's own words in a request message (without the injected editor context / plan). */
export function requestText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .filter((t) => !t.startsWith(`<${CONTEXT_TAG}>`) && !t.startsWith(`<${PLAN_TAG}>`))
    .join('\n')
    .trim();
}

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function compactInput(input: unknown, max = 100): string {
  let s: string;
  try {
    s = JSON.stringify(input) ?? '';
  } catch {
    s = '';
  }
  return oneLine(s, max);
}

/**
 * One line per step of the given (older) messages: user requests, assistant remarks and each tool
 * call with its outcome. Keeps the last `maxLines` lines.
 */
export function buildProgressSummary(messages: readonly ChatMessage[], maxLines = 60): string {
  const results = new Map<string, ToolResultBlock>();
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b);
  }
  const lines: string[] = [];
  for (const m of messages) {
    if (isRequestMessage(m)) {
      const t = requestText(m);
      if (t) lines.push(`User: "${oneLine(t, 240)}"`);
      continue;
    }
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string') {
      if (m.content.trim()) lines.push(`You said: "${oneLine(m.content, 160)}"`);
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim()) lines.push(`You said: "${oneLine(b.text, 160)}"`);
      else if (b.type === 'tool_use') {
        const r = results.get(b.id);
        const text = oneLine(r?.content.find((c): c is TextBlock => c.type === 'text')?.text ?? '', 140);
        const outcome = !r ? 'no result' : r.is_error ? `ERROR ${text}` : `ok ${text}`;
        lines.push(`- ${b.name} ${compactInput(b.input)} -> ${outcome}`);
      }
    }
  }
  if (lines.length > maxLines) {
    const dropped = lines.length - maxLines;
    return [`(${dropped} earlier steps omitted)`, ...lines.slice(-maxLines)].join('\n');
  }
  return lines.join('\n');
}

export interface WindowOptions {
  /** Token budget for the messages (system prompt and tools already subtracted). */
  budgetTokens: number;
  /** Maximum number of recent assistant turns kept verbatim. */
  keepTurns: number;
  /** Builds the condensed header from the omitted messages. */
  header: (omitted: readonly ChatMessage[]) => string;
}

/**
 * Returns the messages to send: the full transcript if it fits, otherwise
 * `[header, ...last K turns]`, with K reduced until it fits (minimum 1).
 * Kept turns always start at an assistant message, so tool_use/tool_result pairs stay intact.
 */
export function windowTranscript(messages: readonly ChatMessage[], opts: WindowOptions): ChatMessage[] {
  if (estimateTokens(messages) <= opts.budgetTokens) return [...messages];
  const req = lastRequestIndex(messages);
  const starts: number[] = [];
  for (let i = req + 1; i < messages.length; i++) if (messages[i]!.role === 'assistant') starts.push(i);
  if (starts.length === 0) return [{ role: 'user', content: opts.header(messages) }];
  let out: ChatMessage[] = [];
  for (let k = Math.min(opts.keepTurns, starts.length); k >= 1; k--) {
    const cut = starts[starts.length - k]!;
    out = [{ role: 'user', content: opts.header(messages.slice(0, cut)) }, ...messages.slice(cut)];
    if (estimateTokens(out) <= opts.budgetTokens) return out;
  }
  return out;
}
