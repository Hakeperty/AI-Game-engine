// Starts a workspace + local API, attaches like `aige mcp` would, and calls tools remotely.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteHostClient, startLocalApi, Workspace } from '../packages/host/src/index.ts';

const ws = new Workspace({ workspaceDir: mkdtempSync(join(tmpdir(), 'aige-api-')), render: null });
await ws.create('live');
const api = await startLocalApi(ws, { lockFile: null });
const client = await RemoteHostClient.connect({ port: api.port, token: api.token, pid: process.pid, root: null, startedAt: '' });
const events: string[] = [];
client.events.add((m) => events.push(m.type === 'event' ? m.event.type : m.type));
await client.request({ type: 'subscribe' });
console.log(await client.request({ type: 'call', name: 'entity_create', input: { name: 'Live' } }));
const tools = await client.request<unknown[]>({ type: 'tools' });
console.log('tools', tools.length, 'events', events.join(','));
const bad = await RemoteHostClient.connect({ port: api.port, token: 'wrong', pid: 0, root: null, startedAt: '' }).then(() => 'connected?!', (e) => `rejected: ${e.message}`);
console.log(bad);
client.close();
await api.close();
await ws.close();
