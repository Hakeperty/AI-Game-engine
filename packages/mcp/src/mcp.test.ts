import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { extractImages, toCallToolResult } from './index.ts';

describe('result conversion', () => {
  it('moves images into image content and strips base64 from the text', () => {
    const r = toCallToolResult({
      ok: true,
      result: { size: [0.1 + 0.2, 1, 2], images: [{ mimeType: 'image/png', data: 'AAAA', label: 'preview', path: '.aige/x.png' }] },
    });
    expect(r.content).toHaveLength(2);
    expect(r.content[0]).toEqual({ type: 'text', text: '{"images":[{"label":"preview","mimeType":"image/png","path":".aige/x.png"}],"size":[0.3,1,2]}' });
    expect(r.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    expect(extractImages({ a: 1 }).images).toEqual([]);
  });

  it('reports errors with isError and the hint', () => {
    const r = toCallToolResult({ ok: false, error: { code: 'NOT_FOUND', message: 'nope', hint: "Did you mean 'Player'?" } });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain("Did you mean 'Player'?");
  });
});

describe('stdio server', () => {
  it('serves tools to an MCP client', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'aige-mcp-test-'));
    const cli = resolve(import.meta.dirname, '..', '..', '..', 'apps', 'cli', 'bin', 'aige.mjs');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', '--workspace', workspace, '--no-render'],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['project_create', 'entity_create', 'model_create', 'render_screenshot']));
    const created = (await client.callTool({ name: 'project_create', arguments: { name: 'demo' } })) as { isError?: boolean };
    expect(created.isError).toBeFalsy();
    const tree = (await client.callTool({ name: 'scene_tree', arguments: {} })) as { content: { text: string }[] };
    expect(tree.content[0]!.text).toContain('Main Camera');
    await client.close();
  }, 60_000);
});
