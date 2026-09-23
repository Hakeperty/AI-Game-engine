import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GODOT_VERSION } from '@aige/godot';

/** Where `aige godot setup` installs Godot .NET (override with AIGE_GODOT = path to the console exe). */
export const GODOT_DIR = join(homedir(), '.aige', 'godot');
const FOLDER = `Godot_v${GODOT_VERSION}-stable_mono_win64`;
export const GODOT_DOWNLOAD = `https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}-stable/${FOLDER}.zip`;

/** Path to the Godot executable; the console build prints to stdout (use it for CLI runs). */
export function godotExe(console = true): string {
  if (process.env.AIGE_GODOT) return process.env.AIGE_GODOT;
  return join(GODOT_DIR, FOLDER, `${FOLDER}${console ? '_console' : ''}.exe`);
}

export const godotInstalled = () => existsSync(godotExe());

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export interface CsDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

/** `dotnet build` the game's C# project; diagnostics use project-relative paths. */
export async function dotnetBuild(
  dir: string,
): Promise<{ ok: boolean; errors: CsDiagnostic[]; warnings: CsDiagnostic[]; log: string }> {
  const r = await run('dotnet', ['build', '-nologo', '-v', 'q', '-clp:NoSummary'], dir, 300_000);
  const seen = new Set<string>();
  const diags: CsDiagnostic[] = [];
  const root = dir.replaceAll('\\', '/').toLowerCase();
  for (const line of `${r.stdout}\n${r.stderr}`.split(/\r?\n/)) {
    const m = /^\s*(.+?)\((\d+),(\d+)\): (error|warning) (\w+): (.*?)(?: \[[^\]]*\])?$/.exec(line);
    if (!m || seen.has(line)) continue;
    seen.add(line);
    let file = m[1]!.replaceAll('\\', '/');
    if (file.toLowerCase().startsWith(root)) file = file.slice(root.length).replace(/^\//, '');
    diags.push({
      file,
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] as 'error' | 'warning',
      code: m[5]!,
      message: m[6]!,
    });
  }
  const errors = diags.filter((d) => d.severity === 'error');
  const ok = r.code === 0 && errors.length === 0;
  return {
    ok,
    errors,
    warnings: diags.filter((d) => d.severity === 'warning').slice(0, 30),
    log: ok ? '' : `${r.stdout}\n${r.stderr}`.trim().slice(-3000),
  };
}

/** Imports new/changed assets (GLBs, textures, audio) so non-editor runs can load them. */
export async function godotImport(dir: string): Promise<{ ok: boolean; log: string }> {
  const r = await run(godotExe(), ['--headless', '--path', dir, '--import'], dir, 600_000);
  const errors = `${r.stdout}\n${r.stderr}`
    .split(/\r?\n/)
    .filter((l) => /ERROR|SCRIPT ERROR/.test(l))
    .slice(0, 20);
  return { ok: !r.timedOut && errors.length === 0, log: errors.join('\n') };
}

export interface GodotTest {
  seconds: number;
  timeScale?: number;
  skipCutscenes?: boolean;
  teleport?: { at: number; entity: string; position: number[]; yaw?: number }[];
  inputs?: { at: number; action?: string; type?: 'down' | 'up' | 'tap'; look?: number[] }[];
  probes?: string[];
  captureAt?: number[];
  capturePrefix?: string;
  camera?: { position: number[]; target: number[]; fov?: number; at?: number };
  quitAfterCaptures?: boolean;
}

export interface GodotReport {
  ok: boolean;
  seconds?: number;
  errors: string[];
  logs: string[];
  events: { t: number; type: string; data?: Record<string, unknown> }[];
  probes: Record<string, { t: number; position: number[]; yaw?: number }[]>;
  final?: Record<string, unknown>;
  screenshots: string[];
}

/** Runs the game with the AigeTest harness (packages/godot/README.md) and returns its report. */
export async function runGodotTest(
  dir: string,
  test: GodotTest,
  opts: { scene?: string; headless?: boolean; resolution?: string } = {},
): Promise<{ report: GodotReport; stdout: string; timedOut: boolean }> {
  const work = join(dir, '.aige', 'godot', `run-${Date.now()}`);
  await mkdir(work, { recursive: true });
  const testPath = join(work, 'test.json');
  const reportPath = join(work, 'report.json');
  await writeFile(testPath, JSON.stringify({ capturePrefix: join(work, 'shot'), ...test }, null, 2));
  const headless = opts.headless ?? !test.captureAt?.length;
  const args = [
    ...(headless
      ? ['--headless']
      : ['--windowed', '--resolution', opts.resolution ?? '1280x720', '--position', '40,40']),
    '--path',
    dir,
    ...(headless ? ['--fixed-fps', '60'] : []),
    ...(opts.scene ? [opts.scene] : []),
    '--',
    `--aige-test=${testPath}`,
    `--aige-report=${reportPath}`,
  ];
  const budget = (test.seconds / (test.timeScale ?? 1)) * 1000 * (headless ? 1 : 1.5) + 90_000;
  const r = await run(godotExe(), args, dir, budget);
  let report: GodotReport;
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8')) as GodotReport;
  } catch {
    const tail = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).slice(-25);
    report = {
      ok: false,
      errors: [
        r.timedOut ? 'Godot timed out before writing a report.' : 'Godot exited without writing a report.',
        ...tail,
      ],
      logs: [],
      events: [],
      probes: {},
      screenshots: [],
    };
  }
  if (!headless) return { report, stdout: r.stdout, timedOut: r.timedOut };
  await rm(work, { recursive: true, force: true }).catch(() => {});
  return { report, stdout: r.stdout, timedOut: r.timedOut };
}

export interface CaptureShot {
  position: number[];
  target: number[];
  fov?: number;
}

/**
 * Renders fixed camera views of a scene with addons/aige/Tools/capture.gd (no C# needed) and returns the
 * PNG paths. The first view waits `settle` frames for GI, fog and shadows.
 */
export async function captureShots(
  dir: string,
  scene: string,
  shots: CaptureShot[],
  opts: { resolution?: string; settle?: number } = {},
): Promise<{ files: string[]; errors: string[] }> {
  const work = join(dir, '.aige', 'godot', `shots-${Date.now()}`);
  await mkdir(work, { recursive: true });
  const job = {
    scene,
    settle: opts.settle ?? 45,
    shots: shots.map((s, i) => ({ fov: 65, ...s, out: join(work, `shot_${i}.png`).replaceAll('\\', '/') })),
  };
  const jobPath = join(work, 'shots.json');
  await writeFile(jobPath, JSON.stringify(job));
  const r = await run(
    godotExe(),
    [
      '--windowed',
      '--resolution',
      opts.resolution ?? '1280x720',
      '--position',
      '40,40',
      '--path',
      dir,
      '-s',
      'res://addons/aige/Tools/capture.gd',
      '--',
      jobPath,
    ],
    dir,
    120_000 + shots.length * 5000,
  );
  const files = job.shots.map((s) => s.out).filter((p) => existsSync(p));
  const errors = `${r.stdout}\n${r.stderr}`
    .split(/\r?\n/)
    .filter((l) => /^(SCRIPT )?ERROR/.test(l) && !/C# script|class could not be found|not compiling/.test(l))
    .slice(0, 10);
  if (r.timedOut) errors.unshift('Godot timed out while capturing.');
  return { files, errors };
}

/** Opens the Godot editor on the project (detached). */
export function openGodotEditor(dir: string): void {
  const child = spawn(godotExe(false), ['--editor', '--path', dir], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
