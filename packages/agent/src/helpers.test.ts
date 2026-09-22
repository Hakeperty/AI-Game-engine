import { describe, expect, it } from 'vitest';
import { buildProgressSummary, estimateTokens, IMAGE_TOKEN_ESTIMATE, windowTranscript } from './context.ts';
import { estimateCostUsd, priceFor } from './pricing.ts';
import { splitImages, summarizeResult } from './results.ts';
import { compactDescription, simplifySchema } from './schema.ts';
import type { ChatMessage } from './types.ts';

describe('simplifySchema (small-model mode)', () => {
  it('drops long descriptions, defaults and noise; flattens nullable anyOf and type unions', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      title: 'Input',
      properties: {
        name: { type: 'string', description: 'Entity name' },
        notes: { type: 'string', description: 'x'.repeat(200) },
        parent: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Parent id', default: null },
        scale: { type: ['number', 'null'], default: 1 },
        tags: { type: 'array', items: { type: 'string', default: 'a', examples: ['b'] }, default: [] },
        mode: { oneOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'number' }, { type: 'null' }] },
        // property names that look like keywords must survive
        default: { type: 'number', default: 3 },
        description: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    };
    expect(simplifySchema(schema, { maxDescriptionChars: 80 })).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Entity name' },
        notes: { type: 'string' },
        parent: { type: 'string', description: 'Parent id' },
        scale: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        mode: { oneOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'number' }] },
        default: { type: 'number' },
        description: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    });
  });

  it('does not mutate its input', () => {
    const schema = { type: 'object', properties: { a: { type: 'number', default: 1 } } };
    simplifySchema(schema);
    expect(schema.properties.a.default).toBe(1);
  });

  it('compacts tool descriptions but keeps the Example line', () => {
    const d =
      'Create an entity with components. Use it for single objects. More detail here.\n\nLong second paragraph.\nExample: {"name":"Crate","position":[0,0.5,0]}';
    expect(compactDescription(d, 40)).toBe(
      'Create an entity with components.\nExample: {"name":"Crate","position":[0,0.5,0]}',
    );
    expect(compactDescription('Short one.')).toBe('Short one.');
  });
});

describe('cost calculation', () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  };

  it('uses the per-model price table', () => {
    // input + output + cache read (0.1x unless noted) + cache write (1.25x)
    expect(estimateCostUsd('claude-opus-5', usage)).toBeCloseTo(5 + 25 + 0.5 + 6.25, 6);
    expect(estimateCostUsd('claude-opus-5-5', usage)).toBeCloseTo(4 + 20 + 0.2 + 5, 6);
    expect(estimateCostUsd('claude-sonnet-5', usage)).toBeCloseTo(2 + 10 + 0.2 + 2.5, 6);
    expect(estimateCostUsd('claude-haiku-4-5', usage)).toBeCloseTo(1 + 5 + 0.1 + 1.25, 6);
    expect(estimateCostUsd('claude-fable-5-1', usage)).toBeCloseTo(10 + 50 + 0.25 + 12.5, 6);
  });

  it('handles dated ids, context tags and unknown/local models', () => {
    expect(priceFor('claude-haiku-4-5-20251001')?.input).toBe(1);
    expect(priceFor('claude-opus-5[1m]')?.output).toBe(25);
    expect(estimateCostUsd('qwen3.8:27b', usage)).toBe(0);
  });

  it('prices a realistic cached agent turn', () => {
    const turn = {
      inputTokens: 2_000,
      outputTokens: 1_500,
      cacheReadTokens: 40_000,
      cacheWriteTokens: 3_000,
    };
    // (2000*5 + 1500*25 + 40000*0.5 + 3000*6.25) / 1e6 = 0.08625
    expect(estimateCostUsd('claude-opus-5', turn)).toBeCloseTo(0.08625, 8);
  });
});

describe('result helpers', () => {
  it('splits images from a result and keeps their metadata', () => {
    const r = {
      ok: true,
      images: [{ mimeType: 'image/png', data: 'QUJD', label: 'iso', path: 'shots/a.png' }],
    };
    const { images, stripped } = splitImages(r);
    expect(images).toHaveLength(1);
    expect(stripped).toEqual({
      ok: true,
      images: [{ mimeType: 'image/png', label: 'iso', path: 'shots/a.png' }],
    });
    expect(r.images[0]!.data).toBe('QUJD'); // input untouched
    expect(splitImages('text').images).toEqual([]);
  });

  it('summarizes results in one line', () => {
    expect(summarizeResult({ id: 'e3', name: 'Coin', transform: { position: [0, 1, 0] } })).toBe(
      'id: e3, name: Coin',
    );
    expect(summarizeResult({ ok: false, errors: ['a', 'b'], warnings: [] }, 1)).toBe(
      'ok: false, errors: 2, warnings: 0 (+1 image)',
    );
    expect(summarizeResult(undefined)).toBe('ok');
  });
});

describe('context helpers', () => {
  const history: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<editor_context>\nScene\n</editor_context>' },
        { type: 'text', text: 'Make a coin game' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Starting.' },
        { type: 'tool_use', id: 'a', name: 'model_from_template', input: { template: 'coin' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'a',
          content: [{ type: 'text', text: '{"model":"models/coin.model.ts"}' }],
        },
      ],
    },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'b', name: 'entity_create', input: { name: 'Coin' } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'b',
          content: [{ type: 'text', text: 'NOT_FOUND: no scene' }],
          is_error: true,
        },
      ],
    },
  ];

  it('estimates tokens as chars/4 with a flat image cost', () => {
    const m: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'x'.repeat(400) },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(100_000) } },
        ],
      },
    ];
    expect(estimateTokens(m)).toBe(100 + IMAGE_TOKEN_ESTIMATE);
  });

  it('summarizes older steps one line each', () => {
    expect(buildProgressSummary(history)).toBe(
      [
        'User: "Make a coin game"',
        'You said: "Starting."',
        '- model_from_template {"template":"coin"} -> ok {"model":"models/coin.model.ts"}',
        '- entity_create {"name":"Coin"} -> ERROR NOT_FOUND: no scene',
      ].join('\n'),
    );
  });

  it('windows the transcript into header + last turns, starting at an assistant message', () => {
    const out = windowTranscript(history, {
      budgetTokens: 10,
      keepTurns: 1,
      header: (o) => `HEADER(${o.length})`,
    });
    expect(out).toEqual([{ role: 'user', content: 'HEADER(3)' }, history[3], history[4]]);
    expect(windowTranscript(history, { budgetTokens: 100_000, keepTurns: 1, header: () => 'x' })).toEqual(
      history,
    );
  });
});
