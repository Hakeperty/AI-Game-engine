import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AigeError, defineCommand } from '@aige/core';
import { z } from 'zod';
import type { ProjectHost } from '../host.ts';
import { type GodotReport, type GodotTest, runGodotTest } from './runner.ts';

type Services = { host: ProjectHost };

const CRITIC = `You are a harsh, experienced game critic and QA tester. You review frames from a game that aims for photorealism (think Resident Evil remakes). Judge each frame as if it were about to ship.
List EVERY problem you can actually see, most severe first:
- characters: uncanny faces, eyes, mouths, hair, hands and fingers, skin, proportions, clothing that clips or looks fake
- animation and poses (compare consecutive frames): popping, sliding feet, broken joints, stiff or unnatural motion
- clipping and intersections, floating or sunken objects, gaps, z-fighting, stretched or missing textures, flat untextured surfaces
- lighting, shadows, exposure, colour; camera framing, composition, cuts; UI and subtitle problems; anything that breaks immersion
Frames are sampled some time apart, so a big pose change between two frames is expected; only flag motion that itself looks broken. A head or body part outside the frame is a camera framing problem, not a missing body part. Letterbox bars, subtitles and the effects listed as intentional (fades, blur, shake) are deliberate, so judge what is under them instead.
Say where in the frame each problem is. Be specific and blunt, never praise, and never invent problems you cannot see.
Reply with JSON only: {"issues":[{"what":"...","where":"...","category":"character|animation|clipping|texture|geometry|lighting|camera|ui|other","severity":1-5,"fix":"..."}],"overall":"one sentence verdict"}`;

const Issue = z.object({
  what: z.string(),
  where: z.string().default(''),
  category: z.string().default('other'),
  severity: z.coerce.number().default(3),
  fix: z.string().default(''),
});
type Issue = z.infer<typeof Issue>;

async function ask(
  baseUrl: string,
  model: string,
  system: string,
  text: string,
  images: string[],
  maxTokens: number,
): Promise<string> {
  const content: unknown[] = [{ type: 'text', text }];
  for (const img of images)
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } });
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
    }),
  });
  const j = (await r.json()) as { choices?: { message: { content: string } }[]; error?: unknown };
  if (!j.choices) throw new Error(JSON.stringify(j.error ?? j).slice(0, 300));
  return j.choices[0]!.message.content.replace(/^```(json)?\s*|```\s*$/g, '');
}

function parseIssues(raw: string): { issues: Issue[]; overall: string } {
  try {
    const j = JSON.parse(raw) as { issues?: unknown[]; overall?: string };
    const issues = (j.issues ?? []).flatMap((i) => {
      const p = Issue.safeParse(i);
      return p.success ? [p.data] : [];
    });
    return { issues, overall: j.overall ?? '' };
  } catch {
    return { issues: [], overall: raw.slice(0, 200) };
  }
}

/** Screen effects (fade, blur, shake...) a cutscene runs around time t, so the critic does not flag them. */
function fxAt(
  doc: {
    tracks?: { type: string; items?: { t: number; effect?: string; to?: number; duration?: number }[] }[];
  } | null,
  t: number,
): string {
  const on: string[] = [];
  for (const tr of doc?.tracks ?? [])
    if (tr.type === 'fx')
      for (const i of tr.items ?? [])
        if (i.t <= t && t <= i.t + (i.duration ?? 0) + 0.6) on.push(`${i.effect} to ${i.to}`);
  return on.join(', ');
}

/** The subtitle / voice line on screen around time t, for context. */
function lineAt(report: GodotReport, t: number): string {
  let text = '';
  for (const e of report.events)
    if (e.type === 'voice' && e.t <= t + 0.2 && t - e.t < 5) text = String(e.data?.text ?? '');
  return text;
}

export const godotCriticCmd = defineCommand({
  name: 'godot_critic',
  group: 'godot',
  kind: 'action',
  tier: 'extended',
  description: `AI critic / QA tester. Plays every cutscene (and a short gameplay session) of the exported Godot game, captures frames, and has a local vision model (default: the AI server's ArcFlare llama-server through an SSH tunnel) review consecutive frames like a harsh critic: uncanny characters, bad animation, clipping, missing textures, lighting, camera, UI. Writes .aige/critic/<run>/report.md (issues ranked and merged, with frame references) and report.json. Slow: about 20 s per request on the server, so a full pass takes a while.
Before the first run: ssh -f -N -L 11435:127.0.0.1:11434 aige-server
Example: {"cutscenes":["cs1_wake","cs3_kitchen"],"fps":1,"flags":["woke_up"]}`,
  input: z
    .object({
      cutscenes: z
        .array(z.string())
        .default([])
        .describe('Cutscene names (cutscenes/<name>.cutscene.json); [] reviews all of them'),
      fps: z.number().min(0.2).max(10).default(1).describe('Frames captured per second of play'),
      framesPerRequest: z
        .number()
        .int()
        .min(1)
        .max(4)
        .default(2)
        .describe('Consecutive frames the model sees at once (2+ lets it judge motion)'),
      gameplay: z
        .number()
        .min(0)
        .max(120)
        .default(12)
        .describe('Seconds of free gameplay to review (0 = none)'),
      flags: z
        .array(z.string())
        .default([])
        .describe('Story flags set before each run, e.g. the one that skips the intro cutscene'),
      baseUrl: z
        .string()
        .default(process.env.AIGE_CRITIC_URL ?? 'http://127.0.0.1:11435/v1')
        .describe('OpenAI-compatible endpoint of the vision model'),
      model: z.string().default(process.env.AIGE_CRITIC_MODEL ?? 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q5_K_XL'),
      maxFrames: z.number().int().min(1).max(2000).default(400).describe('Stop after this many frames'),
    })
    .strict(),
  async run(ctx, input) {
    const host = (ctx.services as Services).host;
    const dir = host.fs.abs('.');
    try {
      const r = await fetch(`${input.baseUrl}/models`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      throw new AigeError('INVALID_STATE', `The critic model at ${input.baseUrl} is not reachable.`, {
        hint: 'Open the tunnel to the AI server: ssh -f -N -L 11435:127.0.0.1:11434 aige-server',
      });
    }
    const names = input.cutscenes.length
      ? input.cutscenes
      : (await host.fs.list('cutscenes', { pattern: /\.cutscene\.json$/ })).map((p) =>
          basename(p).replace('.cutscene.json', ''),
        );
    const segments: { name: string; test: GodotTest; doc?: Parameters<typeof fxAt>[0] }[] = [];
    for (const name of names) {
      const doc = JSON.parse((await host.fs.read(`cutscenes/${name}.cutscene.json`)) ?? 'null');
      if (!doc)
        throw new AigeError('NOT_FOUND', `No cutscene ${name}.`, {
          hint: 'Names come from cutscenes/*.cutscene.json',
        });
      const seconds = Number(doc.duration ?? 20);
      const step = 1 / input.fps;
      const captureAt = Array.from(
        { length: Math.floor(seconds / step) },
        (_, i) => +(0.8 + i * step).toFixed(2),
      );
      segments.push({
        name,
        doc,
        test: {
          seconds: seconds + 1.5,
          flags: input.flags,
          play: [{ at: 0.5, cutscene: `res://cutscenes/${name}.cutscene.json` }],
          captureAt,
          quitAfterCaptures: true,
        },
      });
    }
    if (input.gameplay > 0) {
      const g = input.gameplay;
      segments.push({
        name: 'gameplay',
        test: {
          seconds: g + 1,
          skipCutscenes: true,
          flags: input.flags,
          inputs: [
            { at: 1, action: 'move_forward', type: 'down' },
            { at: g * 0.35, action: 'move_forward', type: 'up' },
            { at: g * 0.4, look: [0.8, 0] },
            { at: g * 0.5, action: 'move_forward', type: 'down' },
            { at: g * 0.75, action: 'move_forward', type: 'up' },
            { at: g * 0.8, action: 'interact', type: 'tap' },
          ],
          captureAt: Array.from(
            { length: Math.floor(g * input.fps) },
            (_, i) => +(1 + i / input.fps).toFixed(2),
          ),
          quitAfterCaptures: true,
        },
      });
    }

    const run = join(dir, '.aige', 'critic', new Date().toISOString().replace(/[:.]/g, '-'));
    await mkdir(run, { recursive: true });
    const found: (Issue & { segment: string; t: number; frame: string })[] = [];
    const verdicts: { segment: string; t: number; overall: string }[] = [];
    let frames = 0;
    for (const seg of segments) {
      if (frames >= input.maxFrames) break;
      const { report } = await runGodotTest(dir, seg.test, { resolution: '960x540' });
      const shots = report.screenshots.map((s, i) => ({ path: s, t: seg.test.captureAt![i] ?? 0 }));
      for (let i = 0; i < shots.length && frames < input.maxFrames; i += input.framesPerRequest) {
        const batch = shots.slice(i, i + input.framesPerRequest);
        frames += batch.length;
        const images = await Promise.all(
          batch.map((b) => readFile(b.path).then((d) => d.toString('base64'))),
        );
        const said = lineAt(report, batch[0]!.t);
        // the harness starts the cutscene at 0.5 s
        const fx = fxAt(seg.doc ?? null, batch[0]!.t - 0.5);
        const text = `${seg.name === 'gameplay' ? 'Gameplay' : `Cutscene "${seg.name}"`}, ${batch.length} consecutive frame(s) at t = ${batch.map((b) => b.t.toFixed(1)).join(', ')} s (${(1 / input.fps).toFixed(1)} s apart).${said ? ` Line being spoken: "${said}".` : ''}${fx ? ` Intentional screen effects right now: ${fx}.` : ''} Review them.`;
        let raw = '';
        try {
          raw = await ask(input.baseUrl, input.model, CRITIC, text, images, 1400);
        } catch (e) {
          verdicts.push({
            segment: seg.name,
            t: batch[0]!.t,
            overall: `critic failed: ${(e as Error).message}`,
          });
          continue;
        }
        const { issues, overall } = parseIssues(raw);
        verdicts.push({ segment: seg.name, t: batch[0]!.t, overall });
        for (const is of issues)
          found.push({ ...is, segment: seg.name, t: batch[0]!.t, frame: batch[0]!.path });
      }
      for (const e of report.errors)
        found.push({
          what: `Runtime error: ${e}`,
          where: '',
          category: 'other',
          severity: 5,
          fix: '',
          segment: seg.name,
          t: 0,
          frame: '',
        });
    }

    // merge duplicates across frames into a ranked list (text only, so it is quick)
    let summary = '';
    if (found.length) {
      const list = found
        .map(
          (f, i) =>
            `${i}. [${f.segment} ${f.t.toFixed(1)}s, sev ${f.severity}, ${f.category}] ${f.what} (${f.where})`,
        )
        .join('\n')
        .slice(0, 60_000);
      try {
        const raw = await ask(
          input.baseUrl,
          input.model,
          'You are a lead QA tester. Merge duplicate reports of the same problem and rank the distinct problems by how badly they hurt a photoreal horror game. Reply with JSON only: {"top":[{"problem":"...","seen":"segments and times","severity":1-5,"fix":"..."}]}',
          `Issue reports from frame-by-frame review:\n${list}`,
          [],
          3000,
        );
        const top =
          (JSON.parse(raw) as { top?: { problem: string; seen: string; severity: number; fix: string }[] })
            .top ?? [];
        summary = top
          .map((p, i) => `${i + 1}. **${p.problem}** (severity ${p.severity}; ${p.seen}). Fix: ${p.fix}`)
          .join('\n');
      } catch {
        summary = '(merge step failed; see the per-frame list)';
      }
    }
    const md = [
      `# Critic report (${new Date().toISOString().slice(0, 16)})`,
      '',
      `Model: ${input.model}. ${frames} frames from ${segments.length} segments, ${found.length} issue reports.`,
      '',
      '## Top problems',
      '',
      summary || 'None reported.',
      '',
      '## Per frame',
      '',
      ...found
        .sort((a, b) => b.severity - a.severity)
        .map(
          (f) =>
            `- **${f.segment} ${f.t.toFixed(1)}s** sev ${f.severity} ${f.category}: ${f.what}${f.where ? ` (${f.where})` : ''}${f.fix ? `. Fix: ${f.fix}` : ''} [frame](${f.frame.replace(/\\/g, '/')})`,
        ),
      '',
      '## Verdicts',
      '',
      ...verdicts.map((v) => `- ${v.segment} ${v.t.toFixed(1)}s: ${v.overall}`),
      '',
    ].join('\n');
    await writeFile(join(run, 'report.md'), md);
    await writeFile(
      join(run, 'report.json'),
      JSON.stringify({ model: input.model, frames, issues: found, verdicts, summary }, null, 2),
    );
    return {
      report: join(run, 'report.md'),
      frames,
      issues: found.length,
      top: summary.split('\n').slice(0, 12),
    };
  },
});
