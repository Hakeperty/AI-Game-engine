import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectHost } from '../packages/host/src/index.ts';
const host = await ProjectHost.create(mkdtempSync(join(tmpdir(), 'aige-script-')), { name: 's' }, { render: null });
const t = Date.now();
console.log(JSON.stringify(await host.call('script_write', { name: 'bad', source: "import { Behaviour } from 'aige';\nexport default class Bad extends Behaviour {\n  update(dt: number) { const x: number = 'str'; this.entity.nope(); }\n}\n" }), null, 1));
console.log('ms', Date.now() - t);
await host.close();
