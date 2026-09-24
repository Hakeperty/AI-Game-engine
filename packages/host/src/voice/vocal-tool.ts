import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AigeError, canonicalJson, defineCommand, VoiceLineDoc } from '@aige/core';
import { z } from 'zod';
import type { ProjectHost } from '../host.ts';
import { ENGINE_ROOT } from '../project-io.ts';
import { decodeWav, encodeOgg, mouthCurve, probeDuration } from './audio.ts';
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
  maxSeconds: z
    .number()
    .min(0)
    .max(20)
    .default(0)
    .describe('Cut longer takes here with a short fade (0 = no limit)'),
  expect: z
    .string()
    .default('')
    .describe('Words the take must contain (Whisper), e.g. "murphy" for a scream that calls a name'),
  line: z
    .string()
    .default('')
    .describe(
      'Also write it as this voice line (audio/voice/<line>.ogg + .json with a lip-sync curve), replacing a TTS line that could not act it',
    ),
  lineText: z.string().default('').describe("Subtitle text for the line (default: the existing line's text)"),
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
    const items = input.sounds.map((s) => ({ ...s, words: s.words || !!s.expect, wav: !!s.line }));
    await writeFile(jobs, JSON.stringify({ voice, out: 'audio/vocal', takes: input.takes, items }));
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
      let line: string | undefined;
      if (s.line) {
        // a proper voice line: ogg + VoiceLineDoc with the mouth curve, so cutscene voice tracks lip-sync it
        const wav = host.fs.abs(`audio/vocal/${s.name}.wav`);
        const pcm = decodeWav(new Uint8Array(await readFile(wav)));
        const audio = `audio/voice/${s.line}.ogg`;
        await host.fs.write(audio, new Uint8Array());
        await encodeOgg(wav, host.fs.abs(audio), 'none');
        await rm(wav, { force: true });
        const old = await host.fs.read(`audio/voice/${s.line}.json`);
        const prev = old ? (JSON.parse(old) as { speaker?: string; text?: string }) : {};
        const doc = VoiceLineDoc.parse({
          format: 'aige.voiceline',
          version: 1,
          id: s.line,
          speaker:
            prev.speaker ??
            (input.voice ? input.voice.charAt(0).toUpperCase() + input.voice.slice(1) : 'Voice'),
          text: s.lineText || prev.text || s.text,
          voice: voice || undefined,
          instruct: `dia: ${s.text}`,
          audio,
          duration: Number(((await probeDuration(host.fs.abs(audio))) ?? seconds).toFixed(3)),
          fps: 30,
          mouth: mouthCurve(pcm, 30),
        });
        await ctx.writeFile(`audio/voice/${s.line}.json`, canonicalJson(doc));
        line = audio;
      }
      sounds.push({
        name: s.name,
        audio: `audio/vocal/${s.name}.ogg`,
        seconds,
        similarity,
        rejected,
        heard,
        ...(line ? { line } : {}),
      });
    }
    return { sounds };
  },
});
