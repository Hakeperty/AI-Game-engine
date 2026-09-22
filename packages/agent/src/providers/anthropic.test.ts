import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';
import type { ChatEvent, ChatMessage, ChatRequest } from '../types.ts';
import {
  AnthropicProvider,
  anthropicError,
  anthropicModelProfile,
  BETA_CONTEXT_EDITING,
  BETA_FALLBACK_ARRAY,
  BETA_FALLBACK_DEFAULT,
  buildAnthropicRequest,
  normalizeAnthropicContent,
  resolveAnthropicConfig,
  toAnthropicMessages,
} from './anthropic.ts';

const req: ChatRequest = {
  system: 'FROZEN SYSTEM PROMPT',
  tools: [
    { name: 'scene_tree', description: 'List entities.', input_schema: { type: 'object', properties: {} } },
    {
      name: 'batch',
      description: 'Run many.',
      input_schema: { type: 'object', properties: { commands: { type: 'array' } } },
    },
    { name: 'plan_update', description: 'Plan.', input_schema: { type: 'object', properties: {} } },
  ],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Build a platformer.' }] }],
};

const build = (opts: Parameters<typeof resolveAnthropicConfig>[0]) =>
  buildAnthropicRequest(resolveAnthropicConfig(opts), req);

describe('buildAnthropicRequest', () => {
  it('claude-opus-5 (default): adaptive thinking, high effort, fallbacks, caching, eager streaming', () => {
    const p = build({});
    expect(p.model).toBe('claude-opus-5');
    expect(p.max_tokens).toBe(64_000);
    expect(p.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(p.output_config).toEqual({ effort: 'high' });
    expect(p.fallbacks).toBe('default');
    expect(p.betas).toEqual([BETA_FALLBACK_DEFAULT, BETA_CONTEXT_EDITING]);
    expect(BETA_FALLBACK_DEFAULT).toBe('server-side-fallback-2026-07-01');
    // prompt caching: explicit breakpoint on the frozen system prompt + top-level automatic caching
    expect(p.cache_control).toEqual({ type: 'ephemeral' });
    expect(p.system).toEqual([
      { type: 'text', text: 'FROZEN SYSTEM PROMPT', cache_control: { type: 'ephemeral' } },
    ]);
    // tools sorted by name, eager input streaming on every tool, auto tool choice
    expect(p.tools?.map((t) => (t as { name: string }).name)).toEqual(['batch', 'plan_update', 'scene_tree']);
    expect(
      p.tools?.every((t) => (t as { eager_input_streaming?: boolean }).eager_input_streaming === true),
    ).toBe(true);
    expect(p.tool_choice).toEqual({ type: 'auto' });
    expect(p.context_management).toEqual({
      edits: [
        {
          type: 'clear_tool_uses_20250919',
          trigger: { type: 'input_tokens', value: 100_000 },
          keep: { type: 'tool_uses', value: 10 },
          clear_at_least: { type: 'input_tokens', value: 20_000 },
          exclude_tools: ['plan_update'],
        },
      ],
    });
    expect('temperature' in p).toBe(false);
  });

  it('claude-opus-5-5: effort is always sent explicitly (API default would be medium)', () => {
    expect(build({ model: 'claude-opus-5-5' }).output_config).toEqual({ effort: 'high' });
    const p = build({ model: 'claude-opus-5-5', effort: 'medium' });
    expect(p.output_config).toEqual({ effort: 'medium' });
    expect(p.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(p.fallbacks).toBe('default');
    expect(p.tool_choice).toEqual({ type: 'auto' });
  });

  it('claude-haiku-4-5: budget thinking, no effort, no fallbacks', () => {
    const p = build({ model: 'claude-haiku-4-5' });
    expect(p.thinking).toEqual({ type: 'enabled', budget_tokens: 12_000 });
    expect(p.output_config).toBeUndefined();
    expect(p.fallbacks).toBeUndefined();
    expect(p.max_tokens).toBe(64_000);
    expect(p.betas).toEqual([BETA_CONTEXT_EDITING]);
    // budget always below max_tokens
    const small = build({ model: 'claude-haiku-4-5', maxTokens: 8000 });
    expect((small.thinking as { budget_tokens: number }).budget_tokens).toBeLessThan(8000);
  });

  it('claude-fable-5-1: thinking param omitted (always on), effort and fallbacks kept', () => {
    const p = build({ model: 'claude-fable-5-1' });
    expect('thinking' in p).toBe(false);
    expect(p.output_config).toEqual({ effort: 'high' });
    expect(p.fallbacks).toBe('default');
  });

  it('claude-sonnet-5: adaptive thinking, fallbacks off unless configured; array form uses its own beta', () => {
    const p = build({ model: 'claude-sonnet-5' });
    expect(p.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(p.fallbacks).toBeUndefined();
    const arr = build({
      model: 'claude-sonnet-5',
      fallbacks: [{ model: 'claude-opus-5', max_tokens: 4000 }],
    });
    expect(arr.fallbacks).toEqual([{ model: 'claude-opus-5', max_tokens: 4000 }]);
    expect(arr.betas).toContain(BETA_FALLBACK_ARRAY);
    expect(arr.betas).not.toContain(BETA_FALLBACK_DEFAULT);
  });

  it('drops betas when fallbacks and context editing are disabled; honours 1h cache TTL', () => {
    const p = build({ fallbacks: false, contextEditing: false, cacheTtl: '1h' });
    expect(p.betas).toBeUndefined();
    expect(p.fallbacks).toBeUndefined();
    expect(p.context_management).toBeUndefined();
    expect(p.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect((p.system as Array<{ cache_control: unknown }>)[0]!.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });

  it('is deterministic and independent of tool order (cache-stable prefix)', () => {
    const cfg = resolveAnthropicConfig({});
    const a = buildAnthropicRequest(cfg, req);
    const b = buildAnthropicRequest(cfg, { ...req, tools: [...req.tools].reverse() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('profiles unknown and dated model ids sensibly', () => {
    expect(anthropicModelProfile('claude-haiku-4-5-20251001').thinking).toBe('budget');
    expect(anthropicModelProfile('claude-opus-4-8')).toMatchObject({
      thinking: 'adaptive',
      effort: true,
      fallbacks: false,
    });
  });
});

describe('toAnthropicMessages', () => {
  it('replays Anthropic blocks unchanged and drops what Claude cannot read', () => {
    const opaque = { type: 'compaction', content: 'summary' };
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'SIG' },
          { type: 'thinking', thinking: 'local model thought' },
          { type: 'redacted_thinking', data: 'REDACTED' },
          { type: 'opaque', provider: 'anthropic', block: opaque },
          { type: 'opaque', provider: 'other', block: { x: 1 } },
          { type: 'text', text: '' },
          { type: 'tool_use', id: 't1', name: 'render_screenshot', input: { views: ['camera'] } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: '{"views":["camera"]}' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                label: 'camera',
              },
            ],
          },
        ],
      },
    ];
    expect(toAnthropicMessages(messages)).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'SIG' },
          { type: 'redacted_thinking', data: 'REDACTED' },
          opaque,
          { type: 'tool_use', id: 't1', name: 'render_screenshot', input: { views: ['camera'] } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: '{"views":["camera"]}' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ],
          },
        ],
      },
    ]);
  });
});

describe('normalizeAnthropicContent', () => {
  it('drops declined-model thinking/tool_use before a fallback block and reports the switch', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'S1' },
      { type: 'text', text: 'Partial answer. ', citations: null },
      { type: 'tool_use', id: 'bad', name: 'entity_delete', input: {} },
      { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'text', text: 'Continued.', citations: null },
      { type: 'tool_use', id: 'good', name: 'scene_tree', input: {} },
    ] as unknown as BetaContentBlock[];
    const { blocks, notices } = normalizeAnthropicContent(content);
    expect(blocks).toEqual([
      { type: 'text', text: 'Partial answer. ' },
      { type: 'text', text: 'Continued.' },
      { type: 'tool_use', id: 'good', name: 'scene_tree', input: {} },
    ]);
    expect(notices).toEqual(['claude-opus-5 declined this request; claude-opus-4-8 continued.']);
  });

  it('flags tool input that is not an object', () => {
    const { blocks } = normalizeAnthropicContent([
      { type: 'tool_use', id: 't', name: 'x', input: 'oops' },
    ] as unknown as BetaContentBlock[]);
    expect(blocks[0]).toMatchObject({
      type: 'tool_use',
      input: {},
      invalid: { error: expect.stringContaining('JSON object') },
    });
  });
});

describe('anthropicError', () => {
  it('classifies SDK errors', () => {
    const rate = Anthropic.APIError.generate(
      429,
      { error: { type: 'rate_limit_error', message: 'slow down' } },
      'slow down',
      new Headers(),
    );
    expect(anthropicError(rate)).toMatchObject({ code: 'rate_limit', status: 429, retryable: true });
    const auth = Anthropic.APIError.generate(
      401,
      { error: { type: 'authentication_error' } },
      'bad key',
      new Headers(),
    );
    expect(anthropicError(auth)).toMatchObject({ code: 'auth', retryable: false });
    expect(anthropicError(new SyntaxError('Unexpected token } in JSON'))).toMatchObject({
      code: 'malformed_output',
    });
    const ctrl = new AbortController();
    ctrl.abort();
    expect(anthropicError(new Error('whatever'), ctrl.signal).code).toBe('aborted');
  });
});

describe('AnthropicProvider.stream (stubbed client)', () => {
  function fakeClient(final: Partial<BetaMessage>, events: unknown[]) {
    const calls: Array<{ params: unknown; options: unknown }> = [];
    const client = {
      beta: {
        messages: {
          stream: (params: unknown, options: unknown) => {
            calls.push({ params, options });
            return {
              currentMessage: { content: final.content ?? [] },
              async *[Symbol.asyncIterator]() {
                yield* events;
              },
              finalMessage: async () => final,
            };
          },
        },
      },
    } as unknown as Anthropic;
    return { client, calls };
  }

  it('maps deltas, tool calls, usage (with cache reads) and the stop reason', async () => {
    const content = [
      { type: 'thinking', thinking: 'plan', signature: 'SIG' },
      { type: 'text', text: 'Looking.', citations: null },
      { type: 'tool_use', id: 'toolu_1', name: 'scene_tree', input: {} },
    ];
    const { client, calls } = fakeClient(
      {
        model: 'claude-opus-5',
        content: content as unknown as BetaContentBlock[],
        stop_reason: 'tool_use',
        stop_details: null,
        usage: {
          input_tokens: 50,
          output_tokens: 40,
          cache_read_input_tokens: 9000,
          cache_creation_input_tokens: 300,
        } as BetaMessage['usage'],
      },
      [
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Looking.' } },
        { type: 'content_block_stop', index: 2 },
      ],
    );
    const provider = new AnthropicProvider({ client });
    const out: ChatEvent[] = [];
    for await (const ev of provider.stream(req)) out.push(ev);
    expect(out.map((e) => e.type)).toEqual(['thinking_delta', 'text_delta', 'tool_use', 'message_done']);
    const done = out.at(-1) as Extract<ChatEvent, { type: 'message_done' }>;
    expect(done.stopReason).toBe('tool_use');
    expect(done.usage).toEqual({
      inputTokens: 50,
      outputTokens: 40,
      cacheReadTokens: 9000,
      cacheWriteTokens: 300,
    });
    expect(done.content).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'SIG' },
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'scene_tree', input: {} },
    ]);
    expect((calls[0]!.params as { model: string }).model).toBe('claude-opus-5');
    expect(provider.caps).toMatchObject({ vision: true, imagesInToolResults: true, promptCache: true });
  });

  it('surfaces refusal details', async () => {
    const { client } = fakeClient(
      {
        model: 'claude-opus-5',
        content: [],
        stop_reason: 'refusal',
        stop_details: { category: 'cyber', explanation: 'declined' } as BetaMessage['stop_details'],
        usage: { input_tokens: 0, output_tokens: 0 } as BetaMessage['usage'],
      },
      [],
    );
    const out: ChatEvent[] = [];
    for await (const ev of new AnthropicProvider({ client }).stream(req)) out.push(ev);
    expect(out[0]).toMatchObject({
      type: 'message_done',
      stopReason: 'refusal',
      refusal: { category: 'cyber' },
    });
  });
});
