// Regression guard: replaying each example's command log into a fresh project must reproduce its scenes exactly.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalJson, parseComponent, SceneDoc } from '@aige/core';
import { describe, expect, it } from 'vitest';
import { ProjectHost } from './index.ts';

const normalizeScene = (s: SceneDoc): SceneDoc => ({
  ...s,
  entities: s.entities.map((e) => ({ ...e, components: e.components.map((c) => parseComponent(c)) })),
});

const EXAMPLES = resolve(import.meta.dirname, '..', '..', '..', 'examples');
const examples = existsSync(EXAMPLES)
  ? readdirSync(EXAMPLES).filter((d) => existsSync(join(EXAMPLES, d, 'commands.jsonl')))
  : [];

describe.skipIf(examples.length === 0)('example replays', () => {
  it.each(examples)(
    '%s replays to identical scenes',
    async (name) => {
      const dir = join(EXAMPLES, name);
      const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
      const log = readFileSync(join(dir, 'commands.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const host = await ProjectHost.create(
        mkdtempSync(join(tmpdir(), 'aige-replay-')),
        { name: project.name },
        { render: null },
      );
      try {
        await host.bus.replay(log);
        for (const file of readdirSync(join(dir, 'scenes'))) {
          const expected = SceneDoc.parse(JSON.parse(readFileSync(join(dir, 'scenes', file), 'utf8')));
          const actual = host.state.scenes[`scenes/${file}`]!;
          // Normalize components through their schemas so newly added defaulted fields don't count as changes.
          expect(canonicalJson(normalizeScene(actual))).toBe(canonicalJson(normalizeScene(expected)));
        }
      } finally {
        await host.close();
      }
    },
    120_000,
  );
});
