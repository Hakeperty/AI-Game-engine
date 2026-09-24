import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AigeError, defineCommand } from '@aige/core';
import { z } from 'zod';
import type { ProjectHost } from '../host.ts';
import { ENGINE_ROOT } from '../project-io.ts';
import { ttsInstalled, ttsPython } from './tts-client.ts';

type Services = { host: ProjectHost };

const Sound = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .describe('File name: the sound is written to audio/vocal/<name>.ogg'),
  text: z
    .string()
    .describe(
      "Dia script. Tags: (gasps) (inhales) (exhales) (sighs) (groans) (screams) (sniffs) (coughs) (clears throat) (mumbles) (laughs); onomatopoeia shapes the rest, e.g. '(sniffs) Hnnn... hnn... (sniffs)' for whimpering or 'Ah! Agh... nngh...' for sharp pain",
    ),
  seconds: z.number().min(0.5).max(12).default(3).describe('Expected length in seconds'),
  words: z
    .boolean()
    .default(false)
    .describe('Allow real words; otherwise takes where Whisper hears speech are rejected'),
  gain: z
    .number()
    .min(0.2)
    .max(3)
    .default(1)
    .describe("Loudness relative to the voice's reference recording"),
  seed: z.number().int().default(1),
});

export const voiceVocalize = defineCommand({
  name: 'voice_vocalize',
  group: 'voice',
  kind: 'mutation',
  tier: 'extended',
  description: `Non-verbal vocalizations that Qwen3-TTS cannot act: gasps, whimpers, sobs, pain groans, screams, panicked breathing, coughs. Runs Nari Labs Dia locally on the GPU, cloning the character's voice from voices/<voice>.ref.wav so the sounds match their lines. Each sound gets several takes; the best wins on speaker similarity, and takes that are cut off, silent or speak real words are rejected. Writes audio/vocal/<name>.ogg plus a <name>.json take report. Play them from cutscene sound tracks ({ sfx: 'audio/vocal/<name>.ogg' }) or Sfx.Play in C#. The first call downloads Dia (~6 GB).
Example: {"voice":"milch","sounds":[{"name":"pain_groan","text":"(groans) Nnngh... ohh... (groans)","seconds":3}]}`,
  input: z
    .object({
      voice: z
        .string()
        .default('')
        .describe("Voice to clone (voices/<voice>.voice.json); '' uses Dia's random voice"),
      sounds: z.array(Sound).min(1).max(40),
      takes: z.number().int().min(1).max(8).default(4).describe('Takes generated per sound'),
    })
    .strict(),
  async run(ctx, input) {
    const host = (ctx.services as Services).host;
    if (!ttsInstalled())
      throw new AigeError('INVALID_STATE', 'The local voice engine is not installed.', {
        hint: 'Run: node apps/cli/bin/aige.mjs tts setup',
      });
    const voice = input.voice
      ? input.voice.includes('/')
        ? input.voice
        : `voices/${input.voice}.voice.json`
      : '';
    if (voice && !(await host.fs.read(voice)))
      throw new AigeError('NOT_FOUND', `No voice at ${voice}.`, {
        hint: 'voice_list shows the voices; voice_design makes one.',
      });
    const dir = await mkdtemp(join(tmpdir(), 'aige-vocal-'));
    const jobs = join(dir, 'jobs.json');
    await writeFile(
      jobs,
      JSON.stringify({ voice, out: 'audio/vocal', takes: input.takes, items: input.sounds }),
    );
    let log = '';
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        ttsPython(),
        [join(ENGINE_ROOT, 'tools', 'tts', 'vocal.py'), host.fs.abs('.'), jobs],
        {
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        },
      );
      child.stdout.on('data', (d) => (log += d));
      child.stderr.on('data', (d) => (log += d));
      child.on('error', reject);
      child.on('close', (c) => resolve(c ?? 1));
    });
    await rm(dir, { recursive: true, force: true });
    if (code !== 0)
      throw new AigeError(
        'BUILD_FAILED',
        `Dia exited with code ${code}: ${log.trim().split('\n').slice(-6).join('\n')}`,
        {
          hint: 'Check GPU memory (tts_status); the first run needs network access to download Dia.',
        },
      );
    const sounds = [];
    for (const s of input.sounds) {
      const report = JSON.parse(await readFile(host.fs.abs(`audio/vocal/${s.name}.json`), 'utf8'));
      const { seconds, similarity, rejected, heard } = report.best;
      sounds.push({ name: s.name, audio: `audio/vocal/${s.name}.ogg`, seconds, similarity, rejected, heard });
    }
    return { sounds };
  },
});
