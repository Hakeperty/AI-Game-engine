import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AigeError } from '@aige/core';
import { ENGINE_ROOT } from '../project-io.ts';

const TTS_DIR = join(ENGINE_ROOT, 'tools', 'tts');
const LOCK = join(homedir(), '.aige', 'tts.json');
const LOG = join(homedir(), '.aige', 'tts.log');

export function ttsPython(): string {
  return process.platform === 'win32'
    ? join(TTS_DIR, '.venv', 'Scripts', 'python.exe')
    : join(TTS_DIR, '.venv', 'bin', 'python');
}

export function ttsInstalled(): boolean {
  return existsSync(ttsPython());
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function health(
  url: string,
): Promise<{ ok: boolean; device?: string; gpu?: string; loaded?: string[] } | null> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? ((await res.json()) as { ok: boolean }) : null;
  } catch {
    return null;
  }
}

/**
 * Client for the local Qwen3-TTS server (tools/tts/server.py). The server is shared by every AIGE
 * process on this machine and keeps its models loaded between calls.
 */
export class TtsClient {
  private url: string | null = null;
  private starting: Promise<string> | null = null;

  async ensure(): Promise<string> {
    if (this.url && (await health(this.url))) return this.url;
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<string> {
    // Reuse a running server.
    if (existsSync(LOCK)) {
      try {
        const { port } = JSON.parse(readFileSync(LOCK, 'utf8')) as { port: number };
        const url = `http://127.0.0.1:${port}`;
        if (await health(url)) return (this.url = url);
      } catch {
        // stale lock
      }
    }
    if (!ttsInstalled()) {
      throw new AigeError('UNSUPPORTED', 'The Qwen3-TTS voice engine is not installed.', {
        hint: 'Run: node apps/cli/bin/aige.mjs tts setup   (creates tools/tts/.venv with PyTorch + qwen-tts, ~5 GB)',
      });
    }
    const port = await freePort();
    mkdirSync(join(homedir(), '.aige'), { recursive: true });
    const log = openSync(LOG, 'a');
    const child = spawn(ttsPython(), [join(TTS_DIR, 'server.py'), '--port', String(port)], {
      cwd: TTS_DIR,
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    child.unref();
    writeFileSync(LOCK, JSON.stringify({ port, pid: child.pid }));
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) {
      if (await health(url)) return (this.url = url);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new AigeError('TIMEOUT', 'The voice server did not start within 60 s.', { hint: `See ${LOG}` });
  }

  async post<T>(path: string, body: unknown, timeoutMs = 15 * 60_000): Promise<T & { ms: number }> {
    const url = await this.ensure();
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as T & { ms: number; error?: string };
    if (!res.ok || json.error) {
      throw new AigeError('INTERNAL', `Voice server error: ${json.error ?? res.statusText}`, {
        hint: `See ${LOG}`,
      });
    }
    return json;
  }

  async status(): Promise<{
    installed: boolean;
    running: boolean;
    device?: string;
    gpu?: string;
    loaded?: string[];
  }> {
    if (!ttsInstalled()) return { installed: false, running: false };
    let url = this.url;
    if (!url && existsSync(LOCK)) {
      try {
        url = `http://127.0.0.1:${(JSON.parse(readFileSync(LOCK, 'utf8')) as { port: number }).port}`;
      } catch {
        url = null;
      }
    }
    const h = url ? await health(url) : null;
    return { installed: true, running: !!h, ...(h ?? {}) };
  }
}

export const tts = new TtsClient();
