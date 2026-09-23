// End-to-end: spawn `aige mcp` over stdio, drive it with the official MCP client like Claude Code would.
// Usage: node scripts/e2e-mcp.ts [--no-render]
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const noRender = process.argv.includes('--no-render');
const workspace = mkdtempSync(join(tmpdir(), 'aige-e2e-'));
const cli = resolve(import.meta.dirname, '..', 'apps', 'cli', 'bin', 'aige.mjs');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, 'mcp', '--workspace', workspace, ...(noRender ? ['--no-render'] : [])],
  stderr: 'pipe',
});
transport.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
const client = new Client({ name: 'aige-e2e', version: '0.0.1' });
await client.connect(transport);

type Content = { type: string; text?: string; data?: string; mimeType?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  const images = res.content.filter((c) => c.type === 'image');
  return { json: JSON.parse(text), images };
}

const t0 = Date.now();
const { tools } = await client.listTools();
console.log(`tools: ${tools.length}`);
const resources = await client.listResources();
console.log(`resources: ${resources.resources.map((r) => r.uri).join(', ')}`);

await call('project_create', { name: 'coin-quest', description: 'e2e test' });
console.log((await call('scene_tree')).json.tree);
const coin = await call('model_from_template', { template: 'coin', preview: !noRender });
console.log('coin model', coin.json.model, coin.json.size, `images: ${coin.images.length}`);
await call('batch', {
  commands: [
    { tool: 'entity_create', input: { name: 'Coins' } },
    {
      tool: 'entity_create',
      input: {
        name: 'Coin',
        parent: '$0.id',
        position: [0, 1, 0],
        tags: ['Coin'],
        components: [
          { type: 'MeshRenderer', model: coin.json.model },
          { type: 'Collider', shape: 'sphere', radius: 0.4, isTrigger: true },
        ],
      },
    },
    { tool: 'entity_duplicate', input: { entity: '$1.id', count: 4, offset: [1.5, 0, 0] } },
  ],
});
const v = await call('scene_validate');
console.log('validate', JSON.stringify(v.json));
if (!noRender) {
  const shot = await call('render_screenshot', { views: ['camera', 'iso'] });
  if (shot.images.length !== 1 || shot.images[0]!.mimeType !== 'image/png')
    throw new Error('expected one PNG image');
  const out = join(workspace, 'e2e-screenshot.png');
  writeFileSync(out, Buffer.from(shot.images[0]!.data!, 'base64'));
  console.log('screenshot saved', out);
}
const bad = (await client.callTool({
  name: 'entity_update',
  arguments: { entity: 'Coinn', position: [0, 0, 0] },
})) as { content: Content[]; isError?: boolean };
if (!bad.isError || !bad.content[0]!.text!.includes('Did you mean'))
  throw new Error('expected a helpful error');
console.log('error hint ok');
await client.close();
console.log(`e2e ok in ${Date.now() - t0} ms (workspace ${workspace})`);
