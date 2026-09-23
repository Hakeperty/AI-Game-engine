// Writes the AI-facing documentation (the same text api_docs / MCP resources serve) to docs/ai/*.md.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOC_TOPICS, ProjectHost } from '../packages/host/src/index.ts';

const out = join(import.meta.dirname, '..', 'docs', 'ai');
mkdirSync(out, { recursive: true });
const host = await ProjectHost.create(
  mkdtempSync(join(tmpdir(), 'aige-docs-')),
  { name: 'docs' },
  { render: null },
);
const index: string[] = [
  '# AIGE documentation for AI agents',
  '',
  'The same text is served by the `api_docs` tool and the `aige://docs/*` MCP resources.',
  '',
];
for (const topic of DOC_TOPICS) {
  const r = await host.call<{ text: string }>('api_docs', { topic }, 'internal');
  if (!r.ok) throw new Error(r.error.message);
  writeFileSync(join(out, `${topic}.md`), `${r.result.text.trim()}\n`);
  index.push(`- [${topic}](${topic}.md)`);
}
writeFileSync(join(out, 'README.md'), `${index.join('\n')}\n`);
await host.close();
console.log(`wrote ${DOC_TOPICS.length} docs to ${out}`);
