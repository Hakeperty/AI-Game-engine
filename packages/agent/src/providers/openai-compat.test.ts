import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { ChatEvent, ChatMessage, ChatRequest, ImageBlock, ToolUseBlock } from '../types.ts';
import {
  detectOllamaCapabilities,
  extractThinking,
  OpenAICompatProvider,
  parseTextToolCalls,
  serverRoot,
  TagRouter,
  toOpenAIMessages,
} from './openai-compat.ts';

const img = (data: string, label?: string): ImageBlock => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data },
  ...(label ? { label } : {}),
});

const transcript: ChatMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Build a coin.' }] },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'secret reasoning', signature: 'sig' },
      { type: 'text', text: 'Creating it.' },
      { type: 'tool_use', id: 'call_1', name: 'model_from_template', input: { template: 'coin' } },
      { type: 'tool_use', id: 'call_2', name: 'scene_tree', input: {} },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [{ type: 'text', text: '{"model":"models/coin.model.ts"}' }, img('AAAA', 'coin preview')],
      },
      {
        type: 'tool_result',
        tool_use_id: 'call_2',
        content: [{ type: 'text', text: 'NOT_FOUND: no scene' }],
        is_error: true,
      },
    ],
  },
];

describe('toOpenAIMessages', () => {
  it('translates tool calls, tool results and images (vision)', () => {
    const out = toOpenAIMessages('SYS', transcript, { vision: true });
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(out[1]).toEqual({ role: 'user', content: 'Build a coin.' });
    expect(out[2]).toEqual({
      role: 'assistant',
      content: 'Creating it.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'model_from_template', arguments: '{"template":"coin"}' },
        },
        { id: 'call_2', type: 'function', function: { name: 'scene_tree', arguments: '{}' } },
      ],
    });
    expect(out[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect((out[3] as { content: string }).content).toContain('{"model":"models/coin.model.ts"}');
    expect((out[3] as { content: string }).content).toContain('attached in the next message');
    expect(out[4]).toEqual({ role: 'tool', tool_call_id: 'call_2', content: 'Error: NOT_FOUND: no scene' });
    // images cannot ride in tool messages: a synthetic user message follows the tool messages
    expect(out[5]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Images returned by the tool calls above:' },
        { type: 'text', text: 'Image from model_from_template: coin preview' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(out).toHaveLength(6);
    expect(JSON.stringify(out)).not.toContain('secret reasoning');
  });

  it('uses placeholders when the model has no vision', () => {
    const out = toOpenAIMessages('', transcript, { vision: false });
    expect(out.some((m) => m.role === 'user' && Array.isArray(m.content))).toBe(false);
    expect((out[2] as { content: string }).content).toContain(
      "[image 'coin preview' not shown: this model cannot see images]",
    );
  });

  it('keeps only the most recent images', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, img('OLD', 'old')] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'render_screenshot', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'c1',
            content: [{ type: 'text', text: '{}' }, img('NEW', 'new')],
          },
        ],
      },
    ];
    const out = toOpenAIMessages('', msgs, { vision: true, maxImages: 1 });
    const json = JSON.stringify(out);
    expect(json).toContain('base64,NEW');
    expect(json).not.toContain('base64,OLD');
    expect(json).toContain("[image 'old' omitted to save context]");
  });

  it('writes tool calls and results as text in text-tool mode', () => {
    const out = toOpenAIMessages('', transcript, { vision: true, textTools: true });
    expect(out.some((m) => m.role === 'tool')).toBe(false);
    const assistant = out[1] as { content: string; tool_calls?: unknown };
    expect(assistant.tool_calls).toBeUndefined();
    expect(assistant.content).toContain(
      '<tool_call>{"name":"model_from_template","arguments":{"template":"coin"}}</tool_call>',
    );
    const results = out[2] as { role: string; content: Array<{ type: string; text?: string }> };
    expect(results.role).toBe('user');
    expect(results.content[0]!.text).toMatch(/^\[tool_result id=call_1 name=model_from_template\]/);
    expect(results.content.some((p) => p.type === 'image_url')).toBe(true);
  });
});

describe('parseTextToolCalls', () => {
  const tools = new Set(['scene_tree', 'entity_create']);

  it('parses <tool_call> blocks and keeps the surrounding text', () => {
    const r = parseTextToolCalls(
      'Let me check.\n<tool_call>\n{"name": "scene_tree", "arguments": {}}\n</tool_call>\n<tool_call>{"name":"entity_create","arguments":{"name":"Box"}}</tool_call>',
      tools,
    );
    expect(r.text).toBe('Let me check.');
    expect(r.calls.map((c) => [c.name, c.input])).toEqual([
      ['scene_tree', {}],
      ['entity_create', { name: 'Box' }],
    ]);
  });

  it('accepts an unterminated final block and string arguments', () => {
    const r = parseTextToolCalls(
      '<tool_call>{"name":"entity_create","arguments":"{\\"name\\":\\"A\\"}"}',
      tools,
    );
    expect(r.calls).toEqual([{ name: 'entity_create', input: { name: 'A' }, raw: expect.any(String) }]);
  });

  it('reports malformed JSON inside a tool_call block', () => {
    const r = parseTextToolCalls(
      '<tool_call>{"name": "entity_create", "arguments": {"name": }</tool_call>',
      tools,
    );
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.name).toBe('entity_create');
    expect(r.calls[0]!.error).toMatch(/Invalid JSON/);
  });

  it('parses a bare JSON object (optionally fenced) with name/arguments', () => {
    expect(parseTextToolCalls('{"name":"scene_tree","arguments":{}}', tools).calls).toHaveLength(1);
    expect(
      parseTextToolCalls('```json\n{"name":"scene_tree","parameters":{"depth":2}}\n```', tools).calls[0]!
        .input,
    ).toEqual({
      depth: 2,
    });
  });

  it('ignores JSON answers that are not tool calls', () => {
    expect(parseTextToolCalls('{"name":"Bob","arguments":{}}', tools).calls).toEqual([]);
    expect(parseTextToolCalls('{"score": 3}', tools).calls).toEqual([]);
    expect(parseTextToolCalls('Just text.', tools)).toEqual({ text: 'Just text.', calls: [] });
  });
});

describe('thinking extraction', () => {
  it('splits <think> blocks and dangling </think>', () => {
    expect(extractThinking('<think>plan it</think>Answer')).toEqual({ thinking: 'plan it', text: 'Answer' });
    expect(extractThinking('reasoning here</think>\nAnswer')).toEqual({
      thinking: 'reasoning here',
      text: 'Answer',
    });
  });

  it('routes streamed deltas across chunk boundaries', () => {
    const r = new TagRouter();
    const out = [
      ...r.push('Hi <thi'),
      ...r.push('nk>deep</th'),
      ...r.push('ink> ok <tool_'),
      ...r.push('call>{"name":1}'),
      ...r.flush(),
    ];
    const text = out
      .filter((p) => p.kind === 'text')
      .map((p) => p.text)
      .join('');
    const thinking = out
      .filter((p) => p.kind === 'thinking')
      .map((p) => p.text)
      .join('');
    expect(text).toBe('Hi  ok ');
    expect(thinking).toBe('deep');
  });
});

describe('detectOllamaCapabilities', () => {
  it('reads capabilities and context length from /api/show', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
      seen.push({ url, ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({
          capabilities: ['completion', 'tools', 'vision', 'thinking'],
          model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const d = await detectOllamaCapabilities('http://localhost:11434/v1/', 'qwen3.8:27b', {
      fetch: fetchStub,
    });
    expect(d).toEqual({
      source: 'ollama',
      tools: true,
      vision: true,
      thinking: true,
      contextLength: 40960,
      capabilities: ['completion', 'tools', 'vision', 'thinking'],
    });
    expect(seen[0]!.url).toBe('http://localhost:11434/api/show');
    expect(seen[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ model: 'qwen3.8:27b' });
  });

  it('reports a missing model with the installed list', async () => {
    const fetchStub = (async (url: string) =>
      url.endsWith('/api/show')
        ? new Response('{"error":"not found"}', { status: 404 })
        : new Response(JSON.stringify({ models: [{ name: 'nemotron-3-nano:4b' }] }), {
            status: 200,
          })) as typeof fetch;
    const d = await detectOllamaCapabilities('http://localhost:11434/v1', 'nope', { fetch: fetchStub });
    expect(d.error).toContain("model 'nope' not found");
    expect(d.error).toContain('nemotron-3-nano:4b');
  });

  it('never throws when nothing answers', async () => {
    const fetchStub = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const d = await detectOllamaCapabilities('http://localhost:9/v1', 'm', { fetch: fetchStub });
    expect(d.source).toBe('none');
    expect(d.tools).toBe(true);
    expect(d.error).toContain('fetch failed');
  });

  it('derives the server root', () => {
    expect(serverRoot('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(serverRoot('http://host:1234/v1/')).toBe('http://host:1234');
  });
});

// ------------------------------------------------------------------ provider with a stubbed client

type Chunk = OpenAI.ChatCompletionChunk;
const chunk = (
  delta: Chunk['choices'][number]['delta'],
  finish: Chunk['choices'][number]['finish_reason'] = null,
): Chunk => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const usageChunk = (prompt: number, completion: number): Chunk => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
});

function stubClient(script: Array<Chunk[] | Error>) {
  const params: OpenAI.ChatCompletionCreateParamsStreaming[] = [];
  let i = 0;
  const client = {
    chat: {
      completions: {
        create: async (p: OpenAI.ChatCompletionCreateParamsStreaming) => {
          params.push(p);
          const step = script[i++];
          if (!step) throw new Error('no scripted response');
          if (step instanceof Error) throw step;
          return (async function* () {
            yield* step;
          })();
        },
      },
    },
  } as unknown as OpenAI;
  return { client, params };
}

async function collect(provider: OpenAICompatProvider, req: ChatRequest): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of provider.stream(req)) out.push(ev);
  return out;
}

const request: ChatRequest = {
  system: 'SYS',
  tools: [
    { name: 'scene_tree', description: 'List entities.', input_schema: { type: 'object', properties: {} } },
  ],
  messages: [{ role: 'user', content: 'what is here?' }],
};

describe('OpenAICompatProvider', () => {
  it('streams native tool calls assembled from argument fragments', async () => {
    const { client, params } = stubClient([
      [
        chunk({ role: 'assistant', content: 'Checking.' }),
        chunk({
          tool_calls: [
            { index: 0, id: 'call_a', type: 'function', function: { name: 'scene_tree', arguments: '{"de' } },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'pth":2}' } }] }),
        chunk({}, 'tool_calls'),
        usageChunk(120, 30),
      ],
    ]);
    const provider = new OpenAICompatProvider({ model: 'qwen3.8:27b', client, detect: false });
    const events = await collect(provider, request);
    const done = events.at(-1) as Extract<ChatEvent, { type: 'message_done' }>;
    expect(done.type).toBe('message_done');
    expect(done.stopReason).toBe('tool_use');
    expect(done.content).toEqual([
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call_a', name: 'scene_tree', input: { depth: 2 } },
    ]);
    expect(done.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(params[0]!.temperature).toBe(0.3);
    expect(params[0]!.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'scene_tree',
          description: 'List entities.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
    expect(params[0]!.stream_options).toEqual({ include_usage: true });
  });

  it('falls back to tool calls written as text, and routes <think> to thinking', async () => {
    const { client } = stubClient([
      [
        chunk({ content: '<think>need the tree</think>Sure.' }),
        chunk({ content: '<tool_call>{"name": "scene_tree", ' }),
        chunk({ content: '"arguments": {}}</tool_call>' }),
        chunk({}, 'stop'),
      ],
    ]);
    const provider = new OpenAICompatProvider({ model: 'm', client, detect: false });
    const events = await collect(provider, request);
    const streamed = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(streamed).toBe('Sure.');
    expect(
      events
        .filter((e) => e.type === 'thinking_delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('need the tree');
    const done = events.at(-1) as Extract<ChatEvent, { type: 'message_done' }>;
    expect(done.stopReason).toBe('tool_use');
    expect(done.content[0]).toEqual({ type: 'thinking', thinking: 'need the tree' });
    expect(done.content[1]).toEqual({ type: 'text', text: 'Sure.' });
    expect(done.content[2]).toMatchObject({ type: 'tool_use', name: 'scene_tree', input: {} });
  });

  it('marks unparseable native arguments as invalid instead of guessing', async () => {
    const { client } = stubClient([
      [
        chunk(
          { tool_calls: [{ index: 0, id: 'c1', function: { name: 'scene_tree', arguments: '{"a": ' } }] },
          'tool_calls',
        ),
      ],
    ]);
    const provider = new OpenAICompatProvider({ model: 'm', client, detect: false });
    const done = (await collect(provider, request)).at(-1) as Extract<ChatEvent, { type: 'message_done' }>;
    const use = done.content[0] as ToolUseBlock;
    expect(use.input).toEqual({});
    expect(use.invalid?.raw).toBe('{"a": ');
  });

  it('switches to the text tool protocol when the model does not support tools', async () => {
    const noTools = OpenAI.APIError.generate(
      400,
      { error: { message: 'registry.ollama.ai/library/tiny does not support tools' } },
      'registry.ollama.ai/library/tiny does not support tools',
      new Headers(),
    );
    const { client, params } = stubClient([noTools, [chunk({ content: 'Hello' }, 'stop')]]);
    const provider = new OpenAICompatProvider({ model: 'tiny', client, detect: false });
    const done = (await collect(provider, request)).at(-1) as Extract<ChatEvent, { type: 'message_done' }>;
    expect(done.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(provider.toolMode).toBe('text');
    expect(params[1]!.tools).toBeUndefined();
    const system = params[1]!.messages[0] as { content: string };
    expect(system.content).toContain('<tool_call>');
    expect(system.content).toContain('- scene_tree: List entities.');
  });

  it('maps connection failures to a helpful network error', async () => {
    const { client } = stubClient([new OpenAI.APIConnectionError({ message: 'Connection error.' })]);
    const provider = new OpenAICompatProvider({ model: 'm', client, detect: false });
    const events = await collect(provider, request);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { code: 'network', retryable: true } });
    expect((events[0] as { error: { message: string } }).error.message).toContain(
      'Is the local model server',
    );
  });

  it('applies detected capabilities in prepare()', async () => {
    const fetchStub = (async () =>
      new Response(
        JSON.stringify({
          capabilities: ['completion', 'vision'],
          model_info: { 'llama.context_length': 8192 },
        }),
        {
          status: 200,
        },
      )) as typeof fetch;
    const { client } = stubClient([]);
    const provider = new OpenAICompatProvider({ model: 'm', client, fetch: fetchStub });
    await provider.prepare();
    expect(provider.caps.vision).toBe(true);
    expect(provider.caps.contextWindow).toBe(8192);
    expect(provider.toolMode).toBe('text'); // no 'tools' capability
    expect(provider.detected?.source).toBe('ollama');
  });

  it('lets explicit caps win over detection', async () => {
    const fetchStub = (async () =>
      new Response(JSON.stringify({ capabilities: ['completion', 'tools', 'vision'] }), {
        status: 200,
      })) as typeof fetch;
    const { client } = stubClient([]);
    const provider = new OpenAICompatProvider({
      model: 'm',
      client,
      fetch: fetchStub,
      caps: { vision: false },
    });
    await provider.prepare();
    expect(provider.caps.vision).toBe(false);
    expect(provider.toolMode).toBe('native');
  });
});
