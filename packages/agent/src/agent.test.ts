import { describe, expect, it } from 'vitest';
import { Agent, type AgentEvent, type ApprovalRequest, defaultNeedsApproval } from './agent.ts';
import { PLAN_TOOL } from './plan.ts';
import { SMALL_MODEL_SYSTEM_PROMPT, SYSTEM_PROMPT } from './prompts.ts';
import { type FakeToolDef, FakeToolHost, MockProvider } from './testing.ts';
import type { ChatMessage, ContentBlock, ImageBlock, TextBlock, ToolResultBlock } from './types.ts';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeHost(extra: FakeToolDef[] = []): FakeToolHost {
  return new FakeToolHost([
    { name: 'scene_tree', kind: 'query', handler: () => ({ entities: ['Ground', 'Player'] }) },
    {
      name: 'entity_get',
      kind: 'query',
      handler: (i: { id: string }) => ({ id: i.id, name: `Entity ${i.id}` }),
    },
    {
      name: 'entity_create',
      kind: 'mutation',
      handler: (i: { name: string }) => ({ id: 'e9', name: i.name }),
    },
    { name: 'entity_delete', kind: 'mutation', handler: () => ({ deleted: 1 }) },
    {
      name: 'render_screenshot',
      kind: 'action',
      handler: () => ({
        views: ['camera'],
        images: [
          {
            mimeType: 'image/png',
            data: PNG,
            label: 'camera view',
            path: '.aige/shots/1.png',
            width: 1,
            height: 1,
          },
        ],
      }),
    },
    {
      name: 'model_create',
      kind: 'mutation',
      handler: () => {
        throw Object.assign(new Error('Recipe failed to build: cylinderr is not defined'), {
          code: 'BUILD_FAILED',
          hint: "Import primitives from 'aige/model'.",
        });
      },
    },
    { name: 'file_write', kind: 'mutation', tier: 'extended', handler: () => ({ ok: true }) },
    ...extra,
  ]);
}

function recorder() {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e: AgentEvent) => events.push(e) };
}

const blocks = (m: ChatMessage | undefined): ContentBlock[] =>
  m && typeof m.content !== 'string' ? m.content : [];
const toolResults = (m: ChatMessage | undefined) =>
  blocks(m).filter((b): b is ToolResultBlock => b.type === 'tool_result');
const firstText = (r: ToolResultBlock) =>
  r.content.find((c): c is TextBlock => c.type === 'text')?.text ?? '';

describe('Agent loop', () => {
  it('answers with text only', async () => {
    const provider = new MockProvider([{ text: 'Hi! What game should we build?' }]);
    const host = makeHost();
    const { events, onEvent } = recorder();
    const agent = new Agent({ provider, tools: host, onEvent });
    const res = await agent.run('hello there');

    expect(res.reason).toBe('end_turn');
    expect(res.text).toBe('Hi! What game should we build?');
    expect(res.turns).toBe(1);
    expect(agent.history).toHaveLength(2);
    expect(host.transactions).toEqual(['AI: hello there']);
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { delta: string }).delta)
        .join(''),
    ).toBe('Hi! What game should we build?');
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'end_turn' });

    const req = provider.requests[0]!;
    expect(req.system).toBe(SYSTEM_PROMPT);
    const names = req.tools.map((t) => t.name);
    expect(names).toContain('plan_update');
    expect(names).toEqual([...names].sort());
  });

  it('runs a tool round trip', async () => {
    const provider = new MockProvider([
      { text: 'Let me look at the scene.', toolCalls: [{ name: 'scene_tree', id: 't1' }] },
      { text: 'The scene has a ground and a player.' },
    ]);
    const host = makeHost();
    const { events, onEvent } = recorder();
    const agent = new Agent({ provider, tools: host, onEvent });
    const res = await agent.run('what is in the scene?');

    expect(res.reason).toBe('end_turn');
    expect(host.calls).toEqual([{ name: 'scene_tree', input: {} }]);
    const second = provider.requests[1]!;
    const results = toolResults(second.messages.at(-1));
    expect(results).toHaveLength(1);
    expect(results[0]!.tool_use_id).toBe('t1');
    expect(JSON.parse(firstText(results[0]!))).toEqual({ entities: ['Ground', 'Player'] });
    const end = events.find((e) => e.type === 'tool_end');
    expect(end).toMatchObject({ type: 'tool_end', name: 'scene_tree', ok: true });
    expect(typeof (end as { durationMs: number }).durationMs).toBe('number');
    expect((end as { summary: string }).summary).toContain('Ground');
  });

  it('runs parallel query calls concurrently and returns all results in one message', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slowQuery = async (i: { id: string }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(20);
      inFlight--;
      return { id: i.id };
    };
    const host = makeHost([{ name: 'entity_info', kind: 'query', handler: slowQuery }]);
    const provider = new MockProvider([
      {
        toolCalls: [
          { name: 'entity_info', input: { id: 'a' }, id: 'q1' },
          { name: 'entity_info', input: { id: 'b' }, id: 'q2' },
          { name: 'entity_info', input: { id: 'c' }, id: 'q3' },
        ],
      },
      { text: 'done' },
    ]);
    await new Agent({ provider, tools: host }).run('inspect a, b and c');

    expect(maxInFlight).toBe(3);
    const msgs = provider.requests[1]!.messages;
    const results = toolResults(msgs.at(-1));
    expect(results.map((r) => r.tool_use_id)).toEqual(['q1', 'q2', 'q3']);
    expect(results.map((r) => JSON.parse(firstText(r)).id)).toEqual(['a', 'b', 'c']);
    // exactly one user message after the assistant turn
    expect(msgs.at(-2)!.role).toBe('assistant');
  });

  it('runs mutations serially in emitted order between query groups', async () => {
    const log: string[] = [];
    const host = makeHost([
      {
        name: 'probe',
        kind: 'query',
        handler: async (i: { n: number }) => {
          log.push(`start q${i.n}`);
          await sleep(10);
          log.push(`end q${i.n}`);
          return {};
        },
      },
      {
        name: 'change',
        kind: 'mutation',
        handler: async (i: { n: number }) => {
          log.push(`start m${i.n}`);
          await sleep(5);
          log.push(`end m${i.n}`);
          return {};
        },
      },
    ]);
    const provider = new MockProvider([
      {
        toolCalls: [
          { name: 'probe', input: { n: 1 } },
          { name: 'probe', input: { n: 2 } },
          { name: 'change', input: { n: 1 } },
          { name: 'change', input: { n: 2 } },
          { name: 'probe', input: { n: 3 } },
        ],
      },
      { text: 'ok' },
    ]);
    await new Agent({ provider, tools: host }).run('go');
    expect(log.slice(0, 2).sort()).toEqual(['start q1', 'start q2']);
    expect(log.slice(4)).toEqual(['start m1', 'end m1', 'start m2', 'end m2', 'start q3', 'end q3']);
    expect(toolResults(provider.requests[1]!.messages.at(-1))).toHaveLength(5);
  });

  it('returns a failing mutation as an is_error tool result with the hint', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ name: 'model_create', input: { name: 'mushroom', source: 'x' }, id: 'm1' }] },
      { text: 'I will fix the recipe.' },
    ]);
    const { events, onEvent } = recorder();
    await new Agent({ provider, tools: makeHost(), onEvent }).run('make a mushroom');

    const [result] = toolResults(provider.requests[1]!.messages.at(-1));
    expect(result!.is_error).toBe(true);
    expect(firstText(result!)).toContain('BUILD_FAILED: Recipe failed to build');
    expect(firstText(result!)).toContain("Hint: Import primitives from 'aige/model'.");
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({
      ok: false,
      error: { code: 'BUILD_FAILED' },
    });
  });

  it('turns result images into image blocks and strips base64 from the JSON text', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ name: 'render_screenshot', id: 's1' }] },
      { text: 'Looks good.' },
    ]);
    const { events, onEvent } = recorder();
    await new Agent({ provider, tools: makeHost(), onEvent }).run('take a screenshot');

    const [result] = toolResults(provider.requests[1]!.messages.at(-1));
    const text = firstText(result!);
    expect(text).not.toContain(PNG);
    const json = JSON.parse(text);
    expect(json.images[0]).toEqual({
      mimeType: 'image/png',
      label: 'camera view',
      path: '.aige/shots/1.png',
      width: 1,
      height: 1,
    });
    const img = result!.content.find((c): c is ImageBlock => c.type === 'image');
    expect(img?.source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG });
    const imageEvent = events.find((e) => e.type === 'image');
    expect(imageEvent).toMatchObject({
      toolUseId: 's1',
      toolName: 'render_screenshot',
      image: { data: PNG },
    });
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ imageCount: 1 });
  });

  it('omits images for models without vision', async () => {
    const provider = new MockProvider([{ toolCalls: [{ name: 'render_screenshot' }] }, { text: 'ok' }], {
      caps: { vision: false },
    });
    await new Agent({ provider, tools: makeHost() }).run('screenshot');
    const [result] = toolResults(provider.requests[1]!.messages.at(-1));
    expect(result!.content.some((c) => c.type === 'image')).toBe(false);
    expect(result!.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')).toContain(
      'cannot see images',
    );
  });

  it('asks for approval in ask-destructive mode and respects a denial', async () => {
    const asked: ApprovalRequest[] = [];
    const provider = new MockProvider([
      {
        toolCalls: [
          { name: 'entity_create', input: { name: 'Box' }, id: 'c1' },
          { name: 'entity_delete', input: { id: 'e1' }, id: 'd1' },
        ],
      },
      { text: 'Okay, I left it.' },
    ]);
    const host = makeHost();
    const { events, onEvent } = recorder();
    const agent = new Agent({
      provider,
      tools: host,
      mode: 'ask-destructive',
      approve: async (req) => {
        asked.push(req);
        return false;
      },
      onEvent,
    });
    await agent.run('replace the box');

    expect(asked.map((a) => a.name)).toEqual(['entity_delete']);
    expect(host.calls.map((c) => c.name)).toEqual(['entity_create']);
    const results = toolResults(provider.requests[1]!.messages.at(-1));
    expect(results[0]!.is_error).toBeUndefined();
    expect(results[1]!.is_error).toBe(true);
    expect(firstText(results[1]!)).toContain('DENIED');
    expect(events.find((e) => e.type === 'tool_denied')).toMatchObject({ name: 'entity_delete' });
  });

  it('denies destructive calls when no approver is configured', async () => {
    const provider = new MockProvider([{ toolCalls: [{ name: 'render_screenshot' }] }, { text: 'ok' }]);
    const host = makeHost();
    await new Agent({ provider, tools: host, mode: 'ask-destructive' }).run('shot');
    expect(host.calls).toEqual([]);
    expect(firstText(toolResults(provider.requests[1]!.messages.at(-1))[0]!)).toContain(
      'no approver configured',
    );
  });

  it('default approval rule covers actions, delete/remove/undo and destructive batch steps', () => {
    const t = (name: string, kind: 'mutation' | 'query' | 'action') => ({
      name,
      kind,
      tier: 'core' as const,
      description: '',
      input_schema: {},
    });
    expect(defaultNeedsApproval(t('render_screenshot', 'action'), {})).toBe(true);
    expect(defaultNeedsApproval(t('entity_delete', 'mutation'), {})).toBe(true);
    expect(defaultNeedsApproval(t('component_remove', 'mutation'), {})).toBe(true);
    expect(defaultNeedsApproval(t('undo', 'mutation'), {})).toBe(true);
    expect(defaultNeedsApproval(t('entity_create', 'mutation'), {})).toBe(false);
    expect(defaultNeedsApproval(t('scene_tree', 'query'), {})).toBe(false);
    expect(
      defaultNeedsApproval(t('batch', 'mutation'), {
        commands: [{ tool: 'entity_create' }, { tool: 'entity_delete' }],
      }),
    ).toBe(true);
    expect(defaultNeedsApproval(t('batch', 'mutation'), { commands: [{ tool: 'entity_create' }] })).toBe(
      false,
    );
  });

  it('read-only mode exposes only query tools', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ name: 'entity_create', input: { name: 'X' } }] },
      { text: 'ok' },
    ]);
    const host = makeHost();
    const agent = new Agent({ provider, tools: host, mode: 'read-only' });
    await agent.run('look around');
    expect(provider.requests[0]!.tools.map((t) => t.name).sort()).toEqual([
      'entity_get',
      'plan_update',
      'scene_tree',
    ]);
    expect(host.calls).toEqual([]);
    expect(firstText(toolResults(provider.requests[1]!.messages.at(-1))[0]!)).toContain('UNKNOWN_TOOL');
  });

  it('stops at maxTurns with a clear message', async () => {
    const provider = new MockProvider(() => ({ toolCalls: [{ name: 'scene_tree' }] }));
    const agent = new Agent({ provider, tools: makeHost(), maxTurns: 3 });
    const res = await agent.run('loop forever');
    expect(res.reason).toBe('max_turns');
    expect(res.turns).toBe(3);
    expect(res.message).toContain('maxTurns');
    expect(provider.requests).toHaveLength(3);
    // history stays valid: every tool_use has a result
    expect(toolResults(agent.history.at(-1))).toHaveLength(1);
  });

  it('stops when the token budget is spent', async () => {
    const provider = new MockProvider(() => ({
      toolCalls: [{ name: 'scene_tree' }],
      usage: { inputTokens: 600 },
    }));
    const res = await new Agent({ provider, tools: makeHost(), maxTokens: 1000 }).run('go');
    expect(res.reason).toBe('token_budget');
    expect(provider.requests).toHaveLength(2);
  });

  it('can be aborted while the model is streaming', async () => {
    const provider = new MockProvider([{ hang: true }]);
    const ctrl = new AbortController();
    const { events, onEvent } = recorder();
    const agent = new Agent({ provider, tools: makeHost(), onEvent });
    const p = agent.run('build a huge world', { signal: ctrl.signal });
    await sleep(10);
    ctrl.abort();
    const res = await p;
    expect(res.reason).toBe('aborted');
    expect(agent.isRunning).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'aborted' });
  });

  it('answers every tool call with a result when aborted mid-tools', async () => {
    const ctrl = new AbortController();
    const host = makeHost([
      {
        name: 'slow_change',
        kind: 'mutation',
        handler: () => {
          ctrl.abort();
          return { ok: true };
        },
      },
    ]);
    const provider = new MockProvider([
      {
        toolCalls: [
          { name: 'slow_change', id: 'a' },
          { name: 'entity_create', input: { name: 'B' }, id: 'b' },
        ],
      },
    ]);
    const agent = new Agent({ provider, tools: host });
    const res = await agent.run('do two things', { signal: ctrl.signal });
    expect(res.reason).toBe('aborted');
    expect(host.calls.map((c) => c.name)).toEqual(['slow_change']);
    const results = toolResults(agent.history.at(-1));
    expect(results.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
    expect(firstText(results[1]!)).toContain('CANCELLED');
  });

  it('keeps an append-only history across runs and round-trips through JSON', async () => {
    const provider = new MockProvider([{ text: 'first answer' }, { text: 'second answer' }]);
    const host = makeHost();
    host.contextText = 'Scene: Main (2 entities)\nSelection: e2 Player';
    const agent = new Agent({ provider, tools: host });
    await agent.run('one');
    await agent.run('two');

    const [r0, r1] = provider.requests;
    expect(r1!.messages.slice(0, r0!.messages.length)).toEqual(r0!.messages);
    expect(r1!.system).toBe(r0!.system);
    expect(r1!.tools).toEqual(r0!.tools);
    const firstUser = blocks(r0!.messages[0]);
    expect((firstUser[0] as TextBlock).text).toMatch(/^<editor_context>\nScene: Main/);
    expect((firstUser.at(-1) as TextBlock).text).toBe('one');

    const saved = JSON.parse(JSON.stringify(agent.toJSON()));
    const provider2 = new MockProvider([{ text: 'third answer' }]);
    const restored = Agent.fromJSON(saved, { provider: provider2, tools: host });
    expect(restored.history).toHaveLength(4);
    await restored.run('three');
    expect(provider2.requests[0]!.messages.slice(0, 4)).toEqual(r1!.messages.concat([agent.history[3]!]));
    expect(provider2.requests[0]!.tools).toEqual(r0!.tools);

    restored.reset();
    expect(restored.history).toHaveLength(0);
    expect(restored.usage.inputTokens).toBe(0);
  });

  it('keeps a plan via the built-in plan_update tool', async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          {
            name: 'plan_update',
            input: {
              items: [
                { text: 'Build models', status: 'in_progress' },
                { text: 'Verify', status: 'pending' },
              ],
            },
          },
        ],
      },
      { text: 'planned' },
      { text: 'next' },
    ]);
    const host = makeHost();
    const { events, onEvent } = recorder();
    const agent = new Agent({ provider, tools: host, onEvent });
    await agent.run('make a game');
    expect(host.calls).toEqual([]);
    expect(agent.plan).toEqual([
      { text: 'Build models', status: 'in_progress' },
      { text: 'Verify', status: 'pending' },
    ]);
    expect(events.find((e) => e.type === 'plan')).toMatchObject({
      items: [{ text: 'Build models' }, { text: 'Verify' }],
    });
    expect(firstText(toolResults(provider.requests[1]!.messages.at(-1))[0]!)).toContain('0/2 done');

    await agent.run('continue');
    const user = blocks(provider.requests[2]!.messages.at(-1));
    expect(user.some((b) => b.type === 'text' && b.text.startsWith('<current_plan>\n[~] Build models'))).toBe(
      true,
    );
  });

  it('rejects an invalid plan with an error result', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ name: 'plan_update', input: { items: [{ text: 'x', status: 'started' }] } }] },
      { text: 'ok' },
    ]);
    await new Agent({ provider, tools: makeHost() }).run('plan');
    const [r] = toolResults(provider.requests[1]!.messages.at(-1));
    expect(r!.is_error).toBe(true);
    expect(firstText(r!)).toContain('INVALID_INPUT');
  });

  it('nudges toward game_run_headless after a script change, once per run', async () => {
    const host = makeHost([
      { name: 'script_write', kind: 'mutation', handler: () => ({ path: 'scripts/enemy.ts' }) },
      { name: 'game_run_headless', kind: 'action', handler: () => ({ score: 3 }) },
    ]);
    const provider = new MockProvider([
      { toolCalls: [{ name: 'script_write', input: { path: 'scripts/enemy.ts', source: '...' } }] },
      { toolCalls: [{ name: 'script_write', input: { path: 'scripts/enemy.ts', source: '...' } }] },
      { text: 'done' },
    ]);
    await new Agent({ provider, tools: host }).run('add an enemy');
    const hintOf = (r: ToolResultBlock) =>
      r.content.some((c) => c.type === 'text' && c.text.includes('game_run_headless'));
    expect(hintOf(toolResults(provider.requests[1]!.messages.at(-1))[0]!)).toBe(true);
    expect(hintOf(toolResults(provider.requests[2]!.messages.at(-1))[0]!)).toBe(false);
  });

  it('does not run tool calls cut off by max_tokens', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ name: 'entity_create', input: { na: 1 } }], stopReason: 'max_tokens' },
      { text: 'I will split it up.' },
    ]);
    const host = makeHost();
    const res = await new Agent({ provider, tools: host }).run('build everything');
    expect(host.calls).toEqual([]);
    expect(firstText(toolResults(provider.requests[1]!.messages.at(-1))[0]!)).toContain('NOT_RUN');
    expect(res.reason).toBe('end_turn');
  });

  it('stops on a refusal without appending the refused turn', async () => {
    const provider = new MockProvider([
      { text: 'partial', stopReason: 'refusal', refusal: { category: 'cyber' } },
    ]);
    const agent = new Agent({ provider, tools: makeHost() });
    const res = await agent.run('something');
    expect(res.reason).toBe('refusal');
    expect(res.message).toContain('cyber');
    expect(agent.history).toHaveLength(1);
  });

  it('re-issues a turn once when the model output could not be parsed', async () => {
    const provider = new MockProvider([
      { error: { code: 'malformed_output', message: 'Unexpected token', retryable: true } },
      { text: 'recovered' },
    ]);
    const res = await new Agent({ provider, tools: makeHost() }).run('go');
    expect(res.reason).toBe('end_turn');
    expect(res.text).toBe('recovered');
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.messages).toEqual(provider.requests[0]!.messages);
  });

  it('reports usage and estimated cost from the price table', async () => {
    const provider = new MockProvider(
      [
        {
          text: 'hi',
          usage: { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 10_000, cacheWriteTokens: 2000 },
        },
      ],
      { model: 'claude-opus-5' },
    );
    const { events, onEvent } = recorder();
    const agent = new Agent({ provider, tools: makeHost(), onEvent });
    const res = await agent.run('hi');
    // (1000*5 + 1000*25 + 10000*0.5 + 2000*6.25) / 1e6
    expect(res.costUsd).toBeCloseTo(0.0475, 6);
    expect(agent.costUsd).toBeCloseTo(0.0475, 6);
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      model: 'claude-opus-5',
      turn: { cacheReadTokens: 10_000 },
      session: { inputTokens: 1000 },
    });
  });

  it('rejects concurrent runs', async () => {
    const provider = new MockProvider([{ hang: true }]);
    const agent = new Agent({ provider, tools: makeHost() });
    const ctrl = new AbortController();
    const p = agent.run('a', { signal: ctrl.signal });
    await expect(agent.run('b')).rejects.toThrow(/already in progress/);
    ctrl.abort();
    await p;
  });
});

describe('Agent small-model mode', () => {
  const longDesc =
    'This description is intentionally very long so that the small-model simplifier drops it because it exceeds the limit.';
  const schemaTool: FakeToolDef = {
    name: 'entity_update',
    kind: 'mutation',
    description: `Update an entity. Many more details follow here.\n\nSecond paragraph that small models do not need.\nExample: {"id":"e1","position":[0,1,0]}`,
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: longDesc },
        position: { anyOf: [{ type: 'array', items: { type: 'number' } }, { type: 'null' }], default: null },
        visible: { type: 'boolean', default: true, description: 'Show it' },
      },
      required: ['id'],
    },
  };

  it('is on for openai-compat providers: core tools only, simplified schemas, short prompt', async () => {
    const provider = new MockProvider([{ text: 'ok' }], { kind: 'openai-compat' });
    const agent = new Agent({ provider, tools: makeHost([schemaTool]) });
    expect(agent.smallModel).not.toBeNull();
    await agent.run('hi');
    const req = provider.requests[0]!;
    expect(req.system).toBe(SMALL_MODEL_SYSTEM_PROMPT);
    const names = req.tools.map((t) => t.name);
    expect(names).not.toContain('file_write'); // extended tier
    expect(names).toContain('plan_update');
    const upd = req.tools.find((t) => t.name === 'entity_update')!;
    expect(upd.description).toBe(
      'Update an entity. Many more details follow here.\nExample: {"id":"e1","position":[0,1,0]}',
    );
    expect(upd.input_schema.properties.id).toEqual({ type: 'string' });
    expect(upd.input_schema.properties.position).toEqual({ type: 'array', items: { type: 'number' } });
    expect(upd.input_schema.properties.visible).toEqual({ type: 'boolean', description: 'Show it' });
  });

  it('can be turned off explicitly', async () => {
    const provider = new MockProvider([{ text: 'ok' }], { kind: 'openai-compat' });
    const agent = new Agent({ provider, tools: makeHost([schemaTool]), smallModel: false });
    await agent.run('hi');
    expect(provider.requests[0]!.tools.map((t) => t.name)).toContain('file_write');
    expect(provider.requests[0]!.system).toBe(SYSTEM_PROMPT);
  });

  it('feeds back a malformed tool call once, then gives up', async () => {
    const bad = {
      content: [
        {
          type: 'tool_use' as const,
          id: 'x1',
          name: 'scene_tree',
          input: {},
          invalid: { raw: '{"a":', error: 'Unexpected end' },
        },
      ],
    };
    const provider = new MockProvider(
      [bad, { ...bad, content: [{ ...bad.content[0]!, id: 'x2' }] }, { text: 'never' }],
      {
        kind: 'openai-compat',
      },
    );
    const host = makeHost();
    const res = await new Agent({ provider, tools: host }).run('look');
    expect(host.calls).toEqual([]);
    const first = toolResults(provider.requests[1]!.messages.at(-1))[0]!;
    expect(first.is_error).toBe(true);
    expect(firstText(first)).toContain('INVALID_JSON');
    expect(firstText(first)).toContain('Unexpected end');
    expect(res.reason).toBe('error');
    expect(provider.requests).toHaveLength(2);
  });

  it('recovers when the retry is well-formed', async () => {
    const provider = new MockProvider(
      [
        {
          content: [
            {
              type: 'tool_use',
              id: 'x1',
              name: 'scene_tree',
              input: {},
              invalid: { raw: '{', error: 'bad' },
            },
          ],
        },
        { toolCalls: [{ name: 'scene_tree' }] },
        { text: 'fine' },
      ],
      { kind: 'openai-compat' },
    );
    const res = await new Agent({ provider, tools: makeHost() }).run('look');
    expect(res.reason).toBe('end_turn');
  });

  it('condenses the transcript into stateless steps when over budget', async () => {
    const big = 'x'.repeat(6000);
    const host = makeHost([{ name: 'big_query', kind: 'query', handler: () => ({ data: big }) }]);
    host.contextText = 'Scene: Main\nSelection: none';
    let n = 0;
    const provider = new MockProvider(
      () => (++n <= 4 ? { toolCalls: [{ name: 'big_query', input: { n } }] } : { text: 'finished' }),
      { kind: 'openai-compat', caps: { contextWindow: 1_000_000 } },
    );
    const { events, onEvent } = recorder();
    const agent = new Agent({
      provider,
      tools: host,
      smallModel: { contextBudgetTokens: 4500, keepTurns: 1 },
      onEvent,
    });
    const res = await agent.run('collect all the data');
    expect(res.reason).toBe('end_turn');
    const last = provider.requests.at(-1)!.messages;
    expect(typeof last[0]!.content).toBe('string');
    const header = last[0]!.content as string;
    expect(header).toContain('## Current request\ncollect all the data');
    expect(header).toContain('## Progress so far');
    expect(header).toContain('- big_query {"n":1} -> ok');
    expect(header).toContain('<editor_context>\nScene: Main');
    expect(last[1]!.role).toBe('assistant');
    expect(last).toHaveLength(3);
    // stored history is untouched (append-only)
    expect(agent.history.length).toBeGreaterThan(last.length);
    expect(events.some((e) => e.type === 'notice' && e.message.includes('condensed'))).toBe(true);
  });
});

describe('plan tool definition', () => {
  it('is a core query tool the model can always use', () => {
    expect(PLAN_TOOL).toMatchObject({ name: 'plan_update', kind: 'query', tier: 'core' });
  });
});
