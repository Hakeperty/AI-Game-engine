import { spawn } from 'node:child_process';

export interface PcmAudio {
  sampleRate: number;
  /** Mono samples in -1..1. */
  samples: Float32Array;
}

/** Decodes a PCM16 / PCM24 / float32 WAV (mixing channels down to mono). */
export function decodeWav(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12;
  let fmt = 1;
  let channels = 1;
  let sampleRate = 24000;
  let bits = 16;
  let data: DataView | null = null;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const size = view.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = view.getUint16(o + 8, true);
      channels = view.getUint16(o + 10, true);
      sampleRate = view.getUint32(o + 12, true);
      bits = view.getUint16(o + 22, true);
      if (fmt === 0xfffe) fmt = view.getUint16(o + 32, true); // WAVE_FORMAT_EXTENSIBLE sub-format
    } else if (id === 'data') {
      data = new DataView(bytes.buffer, bytes.byteOffset + o + 8, Math.min(size, bytes.length - o - 8));
    }
    o += 8 + size + (size % 2);
  }
  if (!data) throw new Error('WAV has no data chunk');
  const bytesPer = bits / 8;
  const frames = Math.floor(data.byteLength / (bytesPer * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * bytesPer;
      let v: number;
      if (fmt === 3) v = bits === 64 ? data.getFloat64(p, true) : data.getFloat32(p, true);
      else if (bits === 16) v = data.getInt16(p, true) / 32768;
      else if (bits === 24)
        v =
          ((data.getUint8(p) | (data.getUint8(p + 1) << 8) | (data.getInt8(p + 2) << 16)) as number) /
          8388608;
      else if (bits === 32) v = data.getInt32(p, true) / 2147483648;
      else v = (data.getUint8(p) - 128) / 128;
      sum += v;
    }
    samples[i] = sum / channels;
  }
  return { sampleRate, samples };
}

/**
 * Lip-sync curve (jaw open 0..1) from speech loudness, sampled at `fps`.
 * Loudness is normalized between the noise floor and the 95th percentile, then smoothed with a fast
 * attack and a slower release so the jaw snaps open on syllables and closes naturally.
 */
export function mouthCurve(audio: PcmAudio, fps = 30): number[] {
  const hop = Math.max(1, Math.round(audio.sampleRate / fps));
  const n = Math.ceil(audio.samples.length / hop);
  const db: number[] = [];
  for (let f = 0; f < n; f++) {
    let sum = 0;
    let zc = 0;
    const start = f * hop;
    const end = Math.min(audio.samples.length, start + hop);
    for (let i = start; i < end; i++) {
      const s = audio.samples[i]!;
      sum += s * s;
      if (i > start && Math.sign(s) !== Math.sign(audio.samples[i - 1]!)) zc++;
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    // Hissy consonants (s, f, sh) have many zero crossings and barely open the jaw.
    const zcr = zc / Math.max(1, end - start);
    const hiss = zcr > 0.25 ? 0.5 : 1;
    db.push(20 * Math.log10(rms * hiss + 1e-6));
  }
  const sorted = [...db].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? -60;
  const floor = Math.max(pct(0.1), -55);
  const peak = Math.max(pct(0.95), floor + 12);
  const out: number[] = [];
  let v = 0;
  for (const d of db) {
    let target = Math.min(1, Math.max(0, (d - floor) / (peak - floor)));
    target = target < 0.12 ? 0 : target ** 0.8;
    v += (target - v) * (target > v ? 0.65 : 0.3);
    out.push(Math.round(v * 1000) / 1000);
  }
  return out;
}

/**
 * Median fundamental frequency (Hz) of the voiced 40 ms frames, found by autocorrelation in 70–500 Hz.
 * Returns 0 when almost nothing is voiced (a true whisper). Used to catch takes whose pitch drifted
 * away from the character's voice.
 */
export function medianPitch(audio: PcmAudio): number {
  const { sampleRate: sr, samples } = audio;
  const n = Math.round(sr * 0.04);
  const lo = Math.floor(sr / 500);
  const hi = Math.ceil(sr / 70);
  const pitches: number[] = [];
  const frame = new Float32Array(n);
  for (let start = 0; start + n + hi < samples.length; start += n >> 1) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += samples[start + i]!;
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      frame[i] = samples[start + i]! - mean;
      energy += frame[i]! ** 2;
    }
    if (Math.sqrt(energy / n) < 0.02) continue;
    let bestLag = 0;
    let bestCorr = 0;
    for (let lag = lo; lag <= hi; lag++) {
      let c = 0;
      for (let i = 0; i + lag < n; i++) c += frame[i]! * frame[i + lag]!;
      if (c > bestCorr) {
        bestCorr = c;
        bestLag = lag;
      }
    }
    if (bestLag && bestCorr > 0.3 * energy) pitches.push(sr / bestLag);
  }
  if (pitches.length < 3) return 0;
  pitches.sort((a, b) => a - b);
  return pitches[pitches.length >> 1]!;
}

export type VoiceEffect = 'none' | 'room' | 'echo' | 'big_echo' | 'muffled' | 'distant';

const EFFECT_FILTERS: Record<VoiceEffect, string> = {
  none: '',
  room: 'aecho=0.8:0.88:45|80:0.22|0.14',
  echo: 'aecho=0.8:0.8:260|520:0.35|0.18',
  big_echo: 'aecho=0.8:0.85:350|700|1050:0.4|0.25|0.12,apad=pad_dur=1',
  muffled: 'lowpass=f=800,volume=0.8',
  distant: 'highpass=f=250,lowpass=f=2500,aecho=0.8:0.8:120:0.3,volume=0.6',
};

/** Converts a WAV to Ogg Vorbis with an optional effect (ffmpeg). Falls back to copying the WAV. */
export async function encodeOgg(
  input: string,
  output: string,
  effect: VoiceEffect = 'none',
): Promise<boolean> {
  const filter = EFFECT_FILTERS[effect];
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input];
  if (filter) args.push('-af', filter);
  args.push('-c:a', 'libvorbis', '-q:a', '5', output);
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args, { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Duration in seconds of a media file (ffprobe), or null. */
export async function probeDuration(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      {
        windowsHide: true,
      },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const v = Number.parseFloat(out.trim());
      resolve(Number.isFinite(v) ? v : null);
    });
  });
}

/** Word error rate between a script line and a transcript (punctuation/case-insensitive). */
export function wordErrorRate(expected: string, actual: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9' ]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const a = norm(expected);
  const b = norm(actual);
  if (a.length === 0) return b.length ? 1 : 0;
  const d: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length]! / a.length;
}
