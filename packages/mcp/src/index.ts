import { type CommandSource, compactJson, type ImageRef, type ToolDefinition, type ToolResult } from '@aige/core';
import { type CallToolResult, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';

/** What the MCP server needs from the engine (a local Workspace or a remote editor connection). */
export interface HostApi {
  tools(): Promise<ToolDefinition[]>;
  call(name: string, input: unknown, source: CommandSource): Promise<ToolResult>;
}

export const SERVER_INSTRUCTIONS = `AIGE is an AI-native game engine plus 3D modeler. You build games entirely through these tools.
Start with project_create (a new game) or project_open. Then:
1. Look at the scene with scene_tree.
2. Make models with model_from_template or model_create, and check every preview image.
3. Place entities with entity_create or batch.
4. Add gameplay with built-in behaviours or script_write.
5. Verify with render_screenshot, scene_validate and game_run_headless.
6. Finish with export_web.
Read api_docs (topics: overview, modeling, scripting, components, templates) before writing recipes or scripts.
Coordinates: Y up, meters, rotations in degrees. The camera sits at +Z looking toward -Z. Models face +Z.
Every change is undoable (undo) and saved automatically.`;

const MAX_TEXT = 60_000;

/** Our engine validates inputs itself (with better error messages), so skip SDK-side validation. */
const passthroughValidator = {
  getValidator: (() => (input: unknown) => ({ valid: true as const, data: input, errorMessage: undefined })) as never,
};

/** Splits images out of a tool result so they can be returned as MCP image content. */
export function extractImages(result: unknown): { json: unknown; images: ImageRef[] } {
  if (!result || typeof result !== 'object' || !Array.isArray((result as { images?: unknown }).images)) {
    return { json: result, images: [] };
  }
  const { images, ...rest } = result as { images: ImageRef[] };
  const refs = images.map(({ data: _d, ...meta }) => meta);
  return { json: { ...rest, images: refs }, images };
}

export function toCallToolResult(r: ToolResult): CallToolResult {
  if (!r.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: r.error }, null, 1) }],
    };
  }
  const { json, images } = extractImages(r.result);
  // compactJson rounds floats (0.09200000000000004 -> 0.092): fewer tokens, easier to read
  let text = compactJson(json ?? { ok: true });
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}… [truncated ${text.length - MAX_TEXT} chars; ask for less detail]`;
  return {
    content: [
      { type: 'text', text },
      ...images.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })),
    ],
  };
}

const DOC_TOPICS = ['overview', 'conventions', 'components', 'modeling', 'templates', 'scripting', 'tools'];

/** Builds an MCP server exposing every AIGE tool, the docs as resources, and a build_game prompt. */
export async function createMcpServer(api: HostApi, version = '0.1.0'): Promise<McpServer> {
  const server = new McpServer(
    { name: 'aige', version },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  for (const tool of await api.tools()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.input_schema as never, passthroughValidator),
        annotations: {
          readOnlyHint: tool.kind === 'query',
          destructiveHint: /delete|remove|undo/.test(tool.name),
          idempotentHint: tool.kind === 'query',
          openWorldHint: false,
        },
      },
      async (args: unknown) => toCallToolResult(await api.call(tool.name, args ?? {}, 'mcp')),
    );
  }
  for (const topic of DOC_TOPICS) {
    server.registerResource(
      `docs-${topic}`,
      `aige://docs/${topic}`,
      { title: `AIGE docs: ${topic}`, mimeType: 'text/markdown' },
      async (uri: URL) => {
        const r = await api.call('api_docs', { topic }, 'mcp');
        const text = r.ok ? (r.result as { text: string }).text : `Unavailable: ${r.error.message}`;
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
      },
    );
  }
  server.registerPrompt(
    'build_game',
    {
      title: 'Build a game with AIGE',
      description: 'Step-by-step instructions for building a complete small game from an idea.',
    },
    async () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `${SERVER_INSTRUCTIONS}

Build a complete, polished small 3D game from the idea the user gives you:
- plan first;
- create every model procedurally and check the previews;
- use built-in behaviours where possible;
- verify with screenshots and a headless play-test that actually reaches the win condition;
- export it with export_web.`,
          },
        },
      ],
    }),
  );
  return server;
}
