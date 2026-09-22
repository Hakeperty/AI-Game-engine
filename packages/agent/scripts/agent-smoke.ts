// Manual connectivity check for the agent against a real model. NOT run by the test suite.
//
//   AIGE_PROVIDER=ollama    AIGE_MODEL=qwen3.8:27b        node packages/agent/scripts/agent-smoke.ts
//   AIGE_PROVIDER=ollama    AIGE_MODEL=nemotron-3-nano:4b node packages/agent/scripts/agent-smoke.ts "your prompt"
//   AIGE_PROVIDER=anthropic AIGE_MODEL=claude-opus-5      node packages/agent/scripts/agent-smoke.ts   (costs money)
//
// Optional: AIGE_BASE_URL (default http://localhost:11434/v1), AIGE_MAX_TURNS (default 8).
// The ToolHost is a tiny in-memory fake with two tools, so nothing touches a real project.
import { Agent, type AgentTool, createProvider, type ToolHost } from '../src/index.ts';

const kind = process.env.AIGE_PROVIDER ?? 'ollama';
const model = process.env.AIGE_MODEL ?? (kind === 'anthropic' ? 'claude-opus-5' : 'qwen3.8:27b');
const prompt =
  process.argv.slice(2).join(' ') ||
  'Add a red crate named "Crate" at position [0, 0.5, 0], then check the scene and tell me what is in it.';

interface Entity {
  id: string;
  name: string;
  position: [number, number, number];
  color: string;
}
const scene: Entity[] = [{ id: 'e1', name: 'Ground', position: [0, 0, 0], color: '#556b2f' }];

const tools: AgentTool[] = [
  {
    name: 'scene_tree',
    description: 'List every entity in the scene with id, name, position and color. Example: {}',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    kind: 'query',
    tier: 'core',
  },
  {
    name: 'entity_create',
    description:
      'Create an entity (a box) in the scene. Example: {"name":"Crate","position":[0,0.5,0],"color":"#aa3322"}',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        color: { type: 'string', description: "'#rrggbb'" },
      },
      required: ['name'],
      additionalProperties: false,
    },
    kind: 'mutation',
    tier: 'core',
  },
];

const host: ToolHost = {
  listTools: () => tools,
  async callTool(name, input) {
    if (name === 'scene_tree') return { ok: true, result: { entities: scene } };
    if (name === 'entity_create') {
      const i = (input ?? {}) as Partial<Entity>;
      if (typeof i.name !== 'string' || !i.name) {
        return {
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'name is required', hint: 'Example: {"name":"Crate"}' },
        };
      }
      const e: Entity = {
        id: `e${scene.length + 1}`,
        name: i.name,
        position: Array.isArray(i.position) && i.position.length === 3 ? i.position : [0, 0, 0],
        color: typeof i.color === 'string' ? i.color : '#cccccc',
      };
      scene.push(e);
      return { ok: true, result: { id: e.id, name: e.name } };
    }
    return { ok: false, error: { code: 'UNKNOWN_COMMAND', message: `Unknown tool '${name}'.` } };
  },
  async transaction(label, fn) {
    console.log(`[transaction] ${label}`);
    return fn();
  },
  async context() {
    return `Scene 'Main' (${scene.length} entities). Selection: none.`;
  },
};

const provider =
  kind === 'anthropic'
    ? createProvider({ kind: 'anthropic', model })
    : createProvider({
        kind: 'openai-compat',
        model,
        baseURL: process.env.AIGE_BASE_URL ?? 'http://localhost:11434/v1',
      });

let lastWasDelta = false;
const agent = new Agent({
  provider,
  tools: host,
  maxTurns: Number(process.env.AIGE_MAX_TURNS ?? 8),
  onEvent(e) {
    if (e.type === 'text' || e.type === 'thinking') {
      if (e.type === 'text') process.stdout.write(e.delta);
      lastWasDelta = true;
      return;
    }
    if (lastWasDelta) process.stdout.write('\n');
    lastWasDelta = false;
    switch (e.type) {
      case 'tool_start':
        console.log(`[tool] ${e.name} ${JSON.stringify(e.input)}`);
        break;
      case 'tool_end':
        console.log(`[tool] ${e.name} -> ${e.ok ? 'ok' : 'ERROR'} (${e.durationMs} ms) ${e.summary}`);
        break;
      case 'plan':
        console.log(`[plan] ${e.items.map((i) => `${i.status}: ${i.text}`).join(' | ')}`);
        break;
      case 'usage':
        console.log(
          `[usage] in ${e.turn.inputTokens} out ${e.turn.outputTokens} cache-read ${e.turn.cacheReadTokens} ~$${e.runCostUsd.toFixed(4)}`,
        );
        break;
      case 'notice':
        console.log(`[notice] ${e.message}`);
        break;
      case 'error':
        console.log(`[error] ${e.error.code}: ${e.error.message}`);
        break;
      case 'done':
        console.log(`[done] ${e.reason}${e.message ? `: ${e.message}` : ''} (${e.turns} turns)`);
        break;
    }
  },
});

console.log(`provider ${provider.id}\nprompt: ${prompt}\n`);
const started = Date.now();
const res = await agent.run(prompt, { signal: AbortSignal.timeout(10 * 60_000) });
console.log(`\ncaps: ${JSON.stringify(provider.caps)}`);
console.log(
  `scene now: ${scene.map((e) => `${e.id} ${e.name} ${JSON.stringify(e.position)} ${e.color}`).join('; ')}`,
);
console.log(`result: ${res.reason} in ${((Date.now() - started) / 1000).toFixed(1)} s, ${res.turns} turns`);
process.exit(res.reason === 'end_turn' ? 0 : 1);
