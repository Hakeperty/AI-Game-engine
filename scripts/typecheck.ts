// Type-checks every workspace that has a tsconfig.json, in parallel.
// TypeScript 7 (native) runs one `tsc -p` per workspace; each package keeps its own lib/types
// so that isomorphic packages (core, modeling) cannot accidentally use DOM or Node APIs.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const projects: string[] = [];
for (const group of ['packages', 'apps']) {
  const dir = join(root, group);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    for (const cfg of [
      'tsconfig.json',
      'tsconfig.node.json',
      'tsconfig.web.json',
      'templates/tsconfig.json',
    ]) {
      const p = join(dir, name, cfg);
      if (existsSync(p)) projects.push(p);
    }
  }
}
for (const extra of ['scripts/tsconfig.json', 'tsconfig.tests.json']) {
  if (existsSync(join(root, extra))) projects.push(join(root, extra));
}

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function run(project: string): Promise<{ project: string; code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsc, '-p', project, '--pretty', 'false'], { cwd: root });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ project, code: code ?? 1, out }));
  });
}

const results = await Promise.all(projects.map(run));
let failed = 0;
for (const r of results) {
  const rel = r.project.slice(root.length + 1).replaceAll('\\', '/');
  if (r.code === 0) {
    console.log(`ok   ${rel}`);
  } else {
    failed++;
    console.log(`FAIL ${rel}\n${r.out}`);
  }
}
if (failed) {
  console.error(`\n${failed} project(s) failed type-checking`);
  process.exit(1);
}
