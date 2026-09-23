import { readFile } from 'node:fs/promises';
import { AigeError, canonicalJson, defineCommand, VoiceLineDoc } from '@aige/core';
import { z } from 'zod';
import type { ProjectHost } from '../host.ts';
import {
  decodeWav,
  encodeOgg,
  medianPitch,
  mouthCurve,
  probeDuration,
  type VoiceEffect,
  wordErrorRate,
} from './audio.ts';
import { tts } from './tts-client.ts';

type Services = { host: ProjectHost };
const hostOf = (ctx: { services: unknown }) => (ctx.services as Services).host;

export const VoiceProfile = z.object({
  format: z.literal('aige.voice'),
  version: z.literal(1),
  name: z.string(),
  /** Natural-language voice description used with Qwen3-TTS VoiceDesign. */
  description: z.string(),
  language: z.string().default('English'),
  /** Reference recording (voice design output) used for consistent voice cloning. */
  refAudio: z.string(),
  refText: z.string(),
  seed: z.number().int().default(1),
});
export type VoiceProfile = z.infer<typeof VoiceProfile>;

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const EFFECTS = ['none', 'room', 'echo', 'big_echo', 'muffled', 'distant'] as const;
const DEFAULT_SAMPLE =
  'I woke up and the house was quiet. Too quiet. Where is everyone? I need to find my little brother.';

async function loadVoice(host: ProjectHost, name: string): Promise<VoiceProfile> {
  const path = name.includes('/') ? name : `voices/${name}.voice.json`;
  const text = await host.fs.read(path);
  if (!text) {
    const voices = (await host.fs.list('voices', { pattern: /\.voice\.json$/ })).map((p) =>
      p.split('/').pop()!.replace('.voice.json', ''),
    );
    throw new AigeError('NOT_FOUND', `Voice '${name}' not found.`, {
      hint: voices.length ? `Voices: ${voices.join(', ')}` : 'Create one with voice_design first.',
    });
  }
  return VoiceProfile.parse(JSON.parse(text));
}

async function transcribe(abs: string): Promise<string> {
  return (await tts.post<{ text: string }>('/asr', { audio: abs })).text;
}

interface Generated {
  wav: string;
  duration: number;
  transcript: string;
  wer: number;
  /** Speaker similarity to the voice's reference recording (1 when not checked). */
  similarity: number;
  /** Median pitch in Hz (0 when unvoiced) and the reference recording's. */
  pitch: number;
  refPitch: number;
  attempts: number;
}

/**
 * Generates speech, verifies it with speech-to-text (and, with `ref`, speaker similarity to the character's
 * reference recording) and keeps the best of up to `attempts` takes.
 */
async function generateVerified(
  host: ProjectHost,
  base: string,
  text: string,
  make: (outAbs: string, seed: number) => Promise<{ duration: number }>,
  opts: {
    attempts: number;
    seed: number;
    maxWer: number;
    ref?: string;
    minSimilarity?: number;
    /** Allow a raised pitch (screaming, shouting). Otherwise takes far from the reference pitch are penalized. */
    raised?: boolean;
  },
): Promise<Generated> {
  const minSim = opts.minSimilarity ?? 0;
  const refPitch = opts.ref ? await pitchOf(host.fs.abs(opts.ref)) : 0;
  // Octaves a take may drift from the reference pitch before it counts against the take.
  const tolerance = opts.raised ? 1.4 : 0.3;
  const drift = (pitch: number) =>
    refPitch && pitch ? Math.max(0, Math.abs(Math.log2(pitch / refPitch)) - tolerance) : 0;
  const score = (g: Generated) => g.similarity - drift(g.pitch) * 0.6;
  const better = (a: Generated, b: Generated) => {
    const aOk = a.wer <= opts.maxWer;
    const bOk = b.wer <= opts.maxWer;
    if (aOk !== bOk) return aOk;
    return aOk ? score(a) > score(b) : a.wer < b.wer;
  };
  let best: Generated | null = null;
  for (let i = 0; i < opts.attempts; i++) {
    const rel = `.aige/tts/${base}-${i}.wav`;
    const abs = host.fs.abs(rel);
    const { duration } = await make(abs, opts.seed + i * 7919);
    const transcript = await transcribe(abs);
    const wer = wordErrorRate(text, transcript);
    const similarity = opts.ref
      ? (
          await tts.post<{ similarity: number[] }>('/similarity', {
            ref: host.fs.abs(opts.ref),
            audios: [abs],
          })
        ).similarity[0]!
      : 1;
    const pitch = await pitchOf(abs);
    const take: Generated = {
      wav: rel,
      duration,
      transcript,
      wer,
      similarity,
      pitch,
      refPitch,
      attempts: i + 1,
    };
    if (!best || better(take, best)) best = { ...take };
    best.attempts = i + 1;
    if (wer <= opts.maxWer && similarity >= minSim && drift(pitch) === 0) break;
  }
  return best!;
}

async function pitchOf(abs: string): Promise<number> {
  return Math.round(medianPitch(decodeWav(new Uint8Array(await readFile(abs)))));
}

export const voiceDesign = defineCommand({
  name: 'voice_design',
  group: 'voice',
  kind: 'mutation',
  tier: 'core',
  description: `Design a character voice with Qwen3-TTS from a natural-language description (age, gender, timbre, accent, mood, pace). It records a reference sample, saved as voices/<name>.voice.json + voices/<name>.ref.wav, which every later voice_line clones so the character always sounds the same. Runs locally on the GPU; the first call downloads the model (a few minutes).
Example: {"name":"milch","description":"An 18-year-old young man with a soft, slightly husky voice. His throat is dry and his voice is quiet and tired, with a hint of fear. Natural American English, unhurried."}`,
  input: z
    .object({
      name: z.string().regex(NAME_RE, 'Use letters, digits, - and _'),
      description: z.string().min(10),
      sample: z
        .string()
        .default(DEFAULT_SAMPLE)
        .describe('Text spoken in the reference recording (neutral delivery works best)'),
      language: z.string().default('English'),
      seed: z.number().int().default(1),
    })
    .strict(),
  async run(ctx, input) {
    const host = hostOf(ctx);
    const refRel = `voices/${input.name}.ref.wav`;
    const best = await generateVerified(
      host,
      `voice-${input.name}`,
      input.sample,
      async (outAbs, seed) => {
        const res = await tts.post<{ files: { duration: number }[] }>('/design', {
          texts: [input.sample],
          outs: [outAbs],
          language: input.language,
          instruct: input.description,
          seed,
        });
        return { duration: res.files[0]!.duration };
      },
      { attempts: 3, seed: input.seed, maxWer: 0.15 },
    );
    await host.fs.write(refRel, new Uint8Array(await readFile(host.fs.abs(best.wav))));
    const profile: VoiceProfile = {
      format: 'aige.voice',
      version: 1,
      name: input.name,
      description: input.description,
      language: input.language,
      refAudio: refRel,
      refText: input.sample,
      seed: input.seed,
    };
    await ctx.writeFile(`voices/${input.name}.voice.json`, canonicalJson(profile));
    return {
      voice: `voices/${input.name}.voice.json`,
      reference: refRel,
      duration: Number(best.duration.toFixed(2)),
      transcript: best.transcript,
      wordErrorRate: Number(best.wer.toFixed(2)),
      attempts: best.attempts,
      next: `voice_line {"id":"${input.name}_line_1","voice":"${input.name}","text":"..."}`,
    };
  },
});

const LineInput = z
  .object({
    id: z.string().regex(NAME_RE, 'Use letters, digits, - and _').describe("Line id, e.g. 'milch_scream_1'"),
    voice: z.string().describe("Voice name from voice_design ('milch')"),
    text: z.string().min(1).describe('What is said (this is also the subtitle)'),
    instruct: z
      .string()
      .optional()
      .describe(
        "Delivery direction, e.g. 'screaming desperately', 'whispering, out of breath', 'hoarse, coughing'",
      ),
    mode: z
      .enum(['auto', 'clone', 'design'])
      .default('auto')
      .describe(
        'clone = exact same voice (neutral delivery); design = follows `instruct` for emotion; auto = design when instruct is set',
      ),
    effect: z
      .enum(EFFECTS)
      .default('none')
      .describe("Post effect: 'echo' for a voice bouncing through an empty house"),
    speaker: z.string().optional().describe('Name shown in subtitles (default: the voice name, capitalized)'),
    seed: z.number().int().default(1),
    attempts: z.number().int().min(1).max(8).default(4).describe('Maximum takes; the best one is kept'),
    minSimilarity: z
      .number()
      .min(0)
      .max(1)
      .default(0.85)
      .describe(
        'Keep regenerating until the take sounds this close to the voice reference (speaker similarity 0..1)',
      ),
  })
  .strict();

async function makeLine(ctx: Parameters<typeof voiceDesign.run>[0], line: z.output<typeof LineInput>) {
  const host = hostOf(ctx);
  const voice = await loadVoice(host, line.voice);
  const mode = line.mode === 'auto' ? (line.instruct ? 'design' : 'clone') : line.mode;
  const best = await generateVerified(
    host,
    line.id,
    line.text,
    async (outAbs, seed) => {
      const res =
        mode === 'clone'
          ? await tts.post<{ files: { duration: number }[] }>('/clone', {
              texts: [line.text],
              outs: [outAbs],
              language: voice.language,
              ref_audio: host.fs.abs(voice.refAudio),
              ref_text: voice.refText,
              seed,
            })
          : await tts.post<{ files: { duration: number }[] }>('/design', {
              texts: [line.text],
              outs: [outAbs],
              language: voice.language,
              instruct: `${voice.description} ${line.instruct ?? ''}`.trim(),
              seed,
            });
      return { duration: res.files[0]!.duration };
    },
    {
      attempts: line.attempts,
      seed: line.seed,
      maxWer: 0.25,
      ref: voice.refAudio,
      minSimilarity: line.minSimilarity,
      raised: /scream|shout|yell|cry|sob|panic|terrif|hyster/i.test(line.instruct ?? ''),
    },
  );
  const wavBytes = new Uint8Array(await readFile(host.fs.abs(best.wav)));
  const mouth = mouthCurve(decodeWav(wavBytes), 30);
  const oggRel = `audio/voice/${line.id}.ogg`;
  let audioRel = oggRel;
  await host.fs.write(oggRel, new Uint8Array()); // ensure the folder exists
  if (!(await encodeOgg(host.fs.abs(best.wav), host.fs.abs(oggRel), line.effect as VoiceEffect))) {
    audioRel = `audio/voice/${line.id}.wav`;
    await host.fs.remove(oggRel);
    await host.fs.write(audioRel, wavBytes);
  }
  const duration = (await probeDuration(host.fs.abs(audioRel))) ?? best.duration;
  const doc: VoiceLineDoc = VoiceLineDoc.parse({
    format: 'aige.voiceline',
    version: 1,
    id: line.id,
    speaker: line.speaker ?? voice.name.charAt(0).toUpperCase() + voice.name.slice(1),
    text: line.text,
    voice: `voices/${voice.name}.voice.json`,
    instruct: line.instruct ?? '',
    audio: audioRel,
    duration: Number(duration.toFixed(3)),
    fps: 30,
    mouth,
  });
  await ctx.writeFile(`audio/voice/${line.id}.json`, canonicalJson(doc));
  return {
    id: line.id,
    audio: audioRel,
    duration: doc.duration,
    mode,
    transcript: best.transcript,
    wordErrorRate: Number(best.wer.toFixed(2)),
    similarity: Number(best.similarity.toFixed(3)),
    pitch: `${best.pitch} Hz (voice ${best.refPitch} Hz)`,
    attempts: best.attempts,
    ...(best.wer > 0.25
      ? {
          warning:
            'The transcript does not match the text well; try a different seed, a clearer text or mode: clone.',
        }
      : {}),
  };
}

export const voiceLine = defineCommand({
  name: 'voice_line',
  group: 'voice',
  kind: 'mutation',
  tier: 'core',
  description: `Generate a spoken line in a character's voice (Qwen3-TTS, local GPU). The audio is checked with speech-to-text and regenerated if it doesn't match the text. It writes audio/voice/<id>.ogg plus audio/voice/<id>.json with the subtitle text and a lip-sync curve, ready for cutscene voice tracks, Interactable/Trigger 'voice', or Voice.play(id).
Example: {"id":"milch_scream_murphy","voice":"milch","text":"Murphy! Murphy!","instruct":"screaming desperately, voice cracking","effect":"echo"}`,
  input: LineInput,
  async run(ctx, input) {
    return makeLine(ctx as never, input);
  },
});

export const voiceLines = defineCommand({
  name: 'voice_lines',
  group: 'voice',
  kind: 'mutation',
  tier: 'extended',
  description:
    'Generate several voice lines in one call (same options as voice_line for each). Example: {"lines":[{"id":"milch_wake_1","voice":"milch","text":"Where... where am I?","instruct":"groggy, dry throat"}]}',
  input: z.object({ lines: z.array(LineInput).min(1).max(40) }).strict(),
  async run(ctx, input) {
    const results = [];
    for (const line of input.lines) results.push(await makeLine(ctx as never, line));
    return { lines: results, totalSeconds: Number(results.reduce((s, r) => s + r.duration, 0).toFixed(1)) };
  },
});

export const voiceList = defineCommand({
  name: 'voice_list',
  group: 'voice',
  kind: 'query',
  tier: 'extended',
  description: 'List character voices and generated voice lines (id, speaker, text, duration).',
  input: z.object({}).strict(),
  async run(ctx) {
    const host = hostOf(ctx);
    const voices = [];
    for (const p of await host.fs.list('voices', { pattern: /\.voice\.json$/ })) {
      const v = VoiceProfile.parse(JSON.parse((await host.fs.read(p))!));
      voices.push({ name: v.name, description: v.description });
    }
    const lines = [];
    for (const p of await host.fs.list('audio/voice', { pattern: /\.json$/ })) {
      const l = VoiceLineDoc.parse(JSON.parse((await host.fs.read(p))!));
      lines.push({ id: l.id, speaker: l.speaker, text: l.text, duration: l.duration, audio: l.audio });
    }
    return { voices, lines };
  },
});

export const ttsStatus = defineCommand({
  name: 'tts_status',
  group: 'voice',
  kind: 'query',
  tier: 'extended',
  description: 'Check the local Qwen3-TTS voice engine: installed, running, GPU and loaded models.',
  input: z.object({}).strict(),
  async run() {
    const s = await tts.status();
    return s.installed ? s : { ...s, hint: 'Run: node apps/cli/bin/aige.mjs tts setup' };
  },
});

export const voiceCommands = [voiceDesign, voiceLine, voiceLines, voiceList, ttsStatus];
