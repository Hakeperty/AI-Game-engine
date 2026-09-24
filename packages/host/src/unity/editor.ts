import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Unity Hub editor folders, per platform. */
function hubDirs(): string[] {
  if (process.platform === 'win32')
    return [
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Unity', 'Hub', 'Editor'),
      'D:\\Unity\\Hub\\Editor',
    ];
  if (process.platform === 'darwin') return ['/Applications/Unity/Hub/Editor'];
  return [join(homedir(), 'Unity', 'Hub', 'Editor')];
}

function exeIn(versionDir: string): string {
  if (process.platform === 'win32') return join(versionDir, 'Editor', 'Unity.exe');
  if (process.platform === 'darwin') return join(versionDir, 'Unity.app', 'Contents', 'MacOS', 'Unity');
  return join(versionDir, 'Editor', 'Unity');
}

/** '6000.5.7f1' → comparable numbers (major, minor, patch, stream, build). */
function versionKey(v: string): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)([abfp])(\d+)/.exec(v);
  if (!m) return [0];
  return [Number(m[1]), Number(m[2]), Number(m[3]), 'abfp'.indexOf(m[4]!), Number(m[5])];
}

/**
 * The Unity editor to use: AIGE_UNITY (path to Unity.exe or to a version folder), else the newest
 * editor installed through Unity Hub. Null when none is installed.
 */
export function unityEditor(): { exe: string; version: string } | null {
  const env = process.env.AIGE_UNITY;
  if (env) {
    const exe = existsSync(env) && /unity(\.exe)?$/i.test(env) ? env : exeIn(env);
    if (existsSync(exe)) return { exe, version: /(\d+\.\d+\.\d+[abfp]\d+)/.exec(exe)?.[1] ?? 'custom' };
  }
  const found: { exe: string; version: string }[] = [];
  for (const dir of hubDirs()) {
    if (!existsSync(dir)) continue;
    for (const v of readdirSync(dir)) {
      const exe = exeIn(join(dir, v));
      if (existsSync(exe)) found.push({ exe, version: v });
    }
  }
  found.sort((a, b) => {
    const ka = versionKey(a.version);
    const kb = versionKey(b.version);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++)
      if ((ka[i] ?? 0) !== (kb[i] ?? 0)) return (kb[i] ?? 0) - (ka[i] ?? 0);
    return 0;
  });
  return found[0] ?? null;
}

/** The editor's bundled package manifest (package versions that match this editor), or null. */
export function editorPackageManifest(exe: string): unknown {
  const candidates = [
    join(exe, '..', 'Data', 'Resources', 'PackageManager', 'Editor', 'manifest.json'),
    join(exe, '..', '..', 'Resources', 'PackageManager', 'Editor', 'manifest.json'),
  ];
  for (const c of candidates)
    if (existsSync(c))
      try {
        return JSON.parse(readFileSync(c, 'utf8'));
      } catch {
        /* ignore */
      }
  return null;
}

export interface CsError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

/** C# compile errors (file:line) from a Unity Editor log, with project-relative paths. */
export function parseCompileErrors(log: string): CsError[] {
  const out: CsError[] = [];
  const seen = new Set<string>();
  for (const line of log.split(/\r?\n/)) {
    const m = /^\s*((?:Assets|Packages|Library)[^()]*\.cs)\((\d+),(\d+)\): error (CS\d+): (.*)$/.exec(line);
    if (!m || seen.has(line)) continue;
    seen.add(line);
    out.push({
      file: m[1]!.replaceAll('\\', '/'),
      line: Number(m[2]),
      column: Number(m[3]),
      code: m[4]!,
      message: m[5]!.trim(),
    });
  }
  return out;
}

/** True when another Unity instance has the project open (its lock file is held). */
export async function projectLocked(projectDir: string): Promise<boolean> {
  const lock = join(projectDir, 'Temp', 'UnityLockfile');
  if (!existsSync(lock)) return false;
  try {
    const h = await open(lock, 'r+');
    await h.close();
    return false;
  } catch {
    return true;
  }
}

export interface UnityRun {
  code: number | null;
  timedOut: boolean;
  log: string;
  logFile: string;
}

/**
 * Runs the Unity editor in batch mode on a project: `-batchmode -quit -projectPath <dir> -logFile <file>`
 * plus `args` (e.g. `-executeMethod Aige.Editor.AigeImporter.ImportAll`). `graphics: false` adds -nographics.
 */
export async function runUnity(
  exe: string,
  projectDir: string,
  args: string[],
  opts: { graphics?: boolean; timeoutMs?: number; logFile: string; quit?: boolean },
): Promise<UnityRun> {
  await rm(opts.logFile, { force: true });
  const full = [
    '-batchmode',
    ...(opts.quit === false ? [] : ['-quit']),
    ...(opts.graphics ? [] : ['-nographics']),
    '-projectPath',
    projectDir,
    '-logFile',
    opts.logFile,
    ...args,
  ];
  const r = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    const child = spawn(exe, full, { windowsHide: true, stdio: 'ignore' });
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill();
      },
      opts.timeoutMs ?? 40 * 60_000,
    );
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
  });
  const log = existsSync(opts.logFile) ? await readFile(opts.logFile, 'utf8') : '';
  return { ...r, log, logFile: opts.logFile };
}

/** Opens the Unity editor on a project (detached). */
export function openUnityEditor(exe: string, projectDir: string, scene?: string): void {
  const args = ['-projectPath', projectDir, ...(scene ? ['-openfile', scene] : [])];
  spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

/** The last lines of a log that explain a failure (errors and exceptions first). */
export function logTail(log: string, lines = 25): string {
  const all = log.split(/\r?\n/);
  const bad = all
    .filter((l) => /error|exception|failed/i.test(l) && !/^\s*at |has no meta file|\.cs\.uid/.test(l))
    .slice(-lines);
  return (bad.length ? bad : all.slice(-lines)).join('\n');
}
