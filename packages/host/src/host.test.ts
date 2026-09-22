import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@aige/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectHost, Workspace } from './index.ts';

process.env.AIGE_BUILD_TIMEOUT_MS = '1500';
const hosts: ProjectHost[] = [];
async function newHost(name = 'test') {
  const dir = mkdtempSync(join(tmpdir(), 'aige-host-'));
  const host = await ProjectHost.create(dir, { name }, { render: null });
  hosts.push(host);
  return host;
}
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
});

async function ok<T = any>(host: ProjectHost, name: string, input: unknown = {}): Promise<T> {
  const r = await host.call<T>(name, input, 'test');
  if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
  return r.result;
}

describe('ProjectHost', () => {
  it('saves every change to disk and reopens identically', async () => {
    const host = await newHost();
    await ok(host, 'entity_create', { name: 'Box', position: [1, 2, 3], components: [{ type: 'MeshRenderer', primitive: 'box' }] });
    await ok(host, 'material_create', { name: 'gold', color: '#ffc107', metalness: 1 });
    await ok(host, 'scene_create', { name: 'level2' });
    await host.flush();
    const reopened = await ProjectHost.open(host.root, { render: null });
    hosts.push(reopened);
    expect(canonicalJson(reopened.state)).toBe(canonicalJson(host.state));
    const log = readFileSync(join(host.root, '.aige/logs/commands.jsonl'), 'utf8').trim().split('\n');
    expect(log.map((l) => JSON.parse(l).name)).toEqual(['entity_create', 'material_create', 'scene_create']);
  });

  it('undo reverts files on disk', async () => {
    const host = await newHost();
    await ok(host, 'entity_create', { name: 'Temp' });
    await ok(host, 'undo');
    await host.flush();
    const scene = JSON.parse(readFileSync(join(host.root, 'scenes/main.scene.json'), 'utf8'));
    expect(scene.entities.map((e: any) => e.name)).not.toContain('Temp');
  });

  it('refuses to write managed JSON or escape the project', async () => {
    const host = await newHost();
    const a = await host.call('file_write', { path: 'scenes/main.scene.json', content: '{}' });
    expect(a.ok).toBe(false);
    const b = await host.call('file_write', { path: '../evil.txt', content: 'x' });
    expect(!b.ok && b.error.message).toMatch(/outside the project/);
  });
});

describe('models', () => {
  it('creates a model from a template with new defaults and caches builds', async () => {
    const host = await newHost();
    const res = await ok(host, 'model_from_template', { template: 'coin', name: 'big-coin', params: { radius: 1 }, preview: false });
    expect(res.model).toBe('models/big-coin.model.ts');
    expect(res.size[0]).toBeCloseTo(2, 3);
    const info1 = await ok(host, 'model_info', { model: 'big-coin' });
    const t = Date.now();
    const info2 = await ok(host, 'model_info', { model: 'big-coin' });
    expect(info2.triangles).toBe(info1.triangles);
    expect(Date.now() - t).toBeLessThan(1000);
    const bad = await host.call('model_from_template', { template: 'coin', params: { size: 3 } });
    expect(!bad.ok && bad.error.hint).toMatch(/radius/);
  });

  it('reports syntax errors with file:line', async () => {
    const host = await newHost();
    const r = await host.call('model_create', {
      name: 'broken',
      source: "import { defineModel, box } from 'aige/model';\nexport default defineModel({ build: () => box( });",
      preview: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('BUILD_FAILED');
      expect(r.error.message).toMatch(/broken\.model\.ts:2:/);
    }
    // failed create is rolled back: the file does not exist
    expect(await host.fs.exists('models/broken.model.ts')).toBe(false);
  });

  it('maps runtime errors back to the recipe source line', async () => {
    const host = await newHost();
    const r = await host.call('model_create', {
      name: 'thrower',
      source: [
        "import { defineModel, box } from 'aige/model';",
        'export default defineModel({',
        '  build() {',
        "    throw new Error('boom');",
        '  },',
        '});',
      ].join('\n'),
      preview: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('SCRIPT_ERROR');
      expect(r.error.message).toMatch(/boom/);
      expect(r.error.message).toMatch(/thrower\.model\.ts:4/);
    }
  });

  it('stops infinite loops and forbids foreign imports', async () => {
    const host = await newHost();
    const loop = await host.call('model_create', {
      name: 'loop',
      source: "import { defineModel, box } from 'aige/model';\nexport default defineModel({ build() { while (true) {} return box(); } });",
      preview: false,
    });
    expect(!loop.ok && loop.error.code).toBe('TIMEOUT');
    const fsImport = await host.call('model_create', {
      name: 'sneaky',
      source:
        "import { readFileSync } from 'node:fs';\nimport { defineModel, box } from 'aige/model';\nexport default defineModel({ build: () => { readFileSync('x'); return box(); } });",
      preview: false,
    });
    expect(!fsImport.ok && fsImport.error.message).toMatch(/Cannot import 'node:fs'/);
  }, 60_000);

  it('recipes can import local helper files', async () => {
    const host = await newHost();
    await ok(host, 'file_write', {
      path: 'models/parts/leg.ts',
      content: "import { cylinder } from 'aige/model';\nexport const leg = (h: number) => cylinder({ radius: 0.05, height: h }).translate([0, h / 2, 0]);\n",
    });
    const res = await ok(host, 'model_create', {
      name: 'table',
      source:
        "import { defineModel, box } from 'aige/model';\nimport { leg } from './parts/leg.ts';\nexport default defineModel({ build: () => box({ size: [1, 0.05, 0.6], center: [0, 0.75, 0] }).merge(leg(0.75).translate([0.45, 0, 0.25]), leg(0.75).translate([-0.45, 0, 0.25]), leg(0.75).translate([0.45, 0, -0.25]), leg(0.75).translate([-0.45, 0, -0.25])) });",
      preview: false,
    });
    expect(res.size[1]).toBeCloseTo(0.775, 3);
  });
});

describe('scene_validate', () => {
  it('finds missing cameras, files and misconfigured built-ins', async () => {
    const host = await newHost();
    await ok(host, 'entity_delete', { entity: 'Main Camera' });
    await ok(host, 'entity_create', {
      name: 'Player',
      components: [{ type: 'Script', script: 'builtin:PlayerControler' }, { type: 'MeshRenderer', model: 'models/nope.model.ts' }],
    });
    const r = await ok(host, 'scene_validate');
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/No active Camera/);
    expect(r.errors.join('\n')).toMatch(/PlayerController/);
    expect(r.errors.join('\n')).toMatch(/nope\.model\.ts/);
  });
});

describe('Workspace', () => {
  it('routes tools and requires a project first', async () => {
    const ws = new Workspace({ workspaceDir: mkdtempSync(join(tmpdir(), 'aige-ws-')), render: null });
    const tools = await ws.tools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['project_create', 'entity_create', 'model_create']));
    const noProject = await ws.call('scene_tree', {});
    expect(!noProject.ok && noProject.error.hint).toMatch(/project_create/);
    const created = await ws.call('project_create', { name: 'demo' });
    expect(created.ok).toBe(true);
    const tree = await ws.call('scene_tree', {});
    expect(tree.ok && (tree.result as any).tree).toMatch(/Main Camera/);
    const list = await ws.call('project_list', {});
    expect(list.ok && (list.result as any).projects).toEqual(['demo']);
    await ws.close();
  });
});
