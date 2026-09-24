import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AigeError, defineCommand, type ImageRef } from '@aige/core';
import { toUnityVector } from '@aige/unity';
import { z } from 'zod';
import type { ProjectHost } from '../host.ts';
import { logTail, openUnityEditor, projectLocked, runUnity, unityEditor } from './editor.ts';
import { exportUnity, UNITY_DIR, unityStatus } from './export.ts';

type Services = { host: ProjectHost };
const hostOf = (ctx: { services: unknown }) => (ctx.services as Services).host;
const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

const requireUnity = () => {
  const editor = unityEditor();
  if (!editor)
    throw new AigeError('UNSUPPORTED', 'Unity is not installed.', {
      hint: 'Install Unity 6 (6000.x) with Unity Hub, or set AIGE_UNITY to the path of Unity.exe.',
    });
  return editor;
};

export const unityExportCmd = defineCommand({
  name: 'unity_export',
  group: 'unity',
  kind: 'action',
  tier: 'core',
  description: `Export the game to Unity 6 (URP; game code is C#) in <game>/unity/. Writes the packages (URP, glTFast, Input System), Assets/Aige (the AIGE C# runtime: Story, Hud, Voice, Sfx, Cutscenes, components, PlayerController, ThirdPersonCamera, test harness; plus the scene importer), bakes every model to GLB, copies textures, MaterialDocs, audio, cutscenes and voice lines, writes the scene data, then runs Unity in batch mode to compile the C# and build Assets/Scenes/<scene>.unity with shared URP materials. Game scripts are C# MonoBehaviours in unity/Assets/Scripts (a first-pass port of each Godot scripts/X.cs is written once). The first run downloads packages and imports everything (several minutes). Returns C# compile errors as file:line.
Example: {"main":"house"}`,
  input: z
    .object({
      main: z.string().optional().describe('Start scene name or path (default: project startScene)'),
      import: z
        .boolean()
        .default(true)
        .describe('Run the Unity importer after writing (false = only write the data)'),
    })
    .strict(),
  async run(ctx, input) {
    const r = await exportUnity(hostOf(ctx), input);
    const u = r.unity;
    return {
      ...r,
      warnings: r.warnings.slice(0, 40),
      ...(u ? { unity: { ...u, importWarnings: u.importWarnings.slice(0, 40) } } : {}),
      next: u?.compileErrors.length
        ? 'Fix the C# errors (unity/Assets/Scripts/*.cs), then unity_export again.'
        : u && !u.ok
          ? 'Read unity.errors and unity.log, fix, and run unity_export again.'
          : 'unity_screenshot to look at it; unity_open to open it in the Unity editor.',
    };
  },
});

export const unityScreenshotCmd = defineCommand({
  name: 'unity_screenshot',
  group: 'unity',
  kind: 'action',
  tier: 'core',
  description: `Render the exported Unity scene (the final URP look: lights, shadows, fog, post-processing) from fixed camera views and return the images. Positions are AIGE coordinates (the tool converts them). Run unity_export first; the editor must not have the project open.
Example: {"scene":"house","views":[{"position":[2,1.6,0.9],"target":[4,0.9,-2.8],"fov":65}]}`,
  input: z
    .object({
      scene: z.string().optional().describe('Scene name (default: the main scene)'),
      views: z
        .array(z.object({ position: Vec3, target: Vec3, fov: z.number().default(60) }))
        .min(1)
        .max(8),
      width: z.number().int().min(320).max(1920).default(1280),
    })
    .strict(),
  async run(ctx, input) {
    const host = hostOf(ctx);
    const editor = requireUnity();
    const dir = host.fs.abs(UNITY_DIR);
    const name = (input.scene ?? host.state.project.startScene)
      .replace(/^.*\//, '')
      .replace(/\.(scene\.json|unity)$/, '');
    const scene = `Assets/Scenes/${name}.unity`;
    if (!existsSync(join(dir, scene)))
      throw new AigeError('INVALID_STATE', `The Unity scene ${scene} does not exist.`, {
        hint: 'Run unity_export first.',
      });
    if (await projectLocked(dir))
      throw new AigeError('INVALID_STATE', 'The Unity project is open in the editor.', {
        hint: 'Close the Unity editor (batch rendering needs the project), then try again.',
      });
    const out = host.fs.abs(`.aige/unity-shots/${Date.now()}`);
    await mkdir(out, { recursive: true });
    const request = join(out, 'request.json');
    const height = Math.round((input.width * 9) / 16);
    await writeFile(
      request,
      JSON.stringify({
        scene,
        width: input.width,
        height,
        out,
        views: input.views.map((v) => ({
          position: toUnityVector(v.position),
          target: toUnityVector(v.target),
          fov: v.fov,
        })),
      }),
    );
    const run = await runUnity(
      editor.exe,
      dir,
      ['-executeMethod', 'Aige.Editor.AigeShots.Capture', '-aigeShots', request],
      {
        graphics: true,
        logFile: join(out, 'unity.log'),
        timeoutMs: 20 * 60_000,
      },
    );
    let result: { files?: string[]; errors?: string[] } = {};
    try {
      result = JSON.parse(await readFile(join(out, 'shots.json'), 'utf8'));
    } catch {
      /* failed before writing */
    }
    const images: ImageRef[] = [];
    for (const [i, abs] of (result.files ?? []).entries()) {
      const bytes = await readFile(abs);
      const rel = `.aige/screenshots/unity-${Date.now()}-${i}.png`;
      await host.fs.write(rel, new Uint8Array(bytes));
      images.push({
        mimeType: 'image/png',
        data: bytes.toString('base64'),
        label: `view ${i + 1}`,
        path: rel,
      });
    }
    if (!images.length)
      throw new AigeError('RENDER_FAILED', 'Unity did not produce a screenshot.', {
        hint: (result.errors ?? []).join(' | ') || logTail(run.log, 8),
      });
    return { images, errors: result.errors ?? [] };
  },
});

export const unityOpenCmd = defineCommand({
  name: 'unity_open',
  group: 'unity',
  kind: 'action',
  tier: 'extended',
  description:
    'Open the exported Unity project in the Unity editor (for the human to look around, press Play, or tweak). Example: {}',
  input: z.object({}).strict(),
  async run(ctx) {
    const editor = requireUnity();
    const host = hostOf(ctx);
    const dir = host.fs.abs(UNITY_DIR);
    if (!existsSync(join(dir, 'Assets', 'AigeData', 'project.json')))
      throw new AigeError('INVALID_STATE', 'Not exported yet.', { hint: 'Run unity_export first.' });
    openUnityEditor(editor.exe, dir);
    return { opened: dir, editor: editor.version };
  },
});

export const unityStatusCmd = defineCommand({
  name: 'unity_status',
  group: 'unity',
  kind: 'query',
  tier: 'extended',
  description:
    'Unity export status: installed editor, exported scenes, last import, whether the editor has the project open. Example: {}',
  input: z.object({}).strict(),
  async run(ctx) {
    return unityStatus(hostOf(ctx));
  },
});

export const unityPlayTestCmd = defineCommand({
  name: 'unity_play_test',
  group: 'unity',
  kind: 'action',
  tier: 'core',
  description: `Play-test the exported Unity game in the editor's Play mode (batch mode, fixed 60 fps) with scripted input and get a report: story events (flags, interactions, doors, triggers, cutscenes, voice lines, objectives), probe tracks, final state, C# errors, and screenshots at captureAt times. Positions are AIGE coordinates. Run unity_export first.
Example: {"seconds":25,"teleport":[{"at":0,"entity":"Hero","position":[0,0,2],"yaw":180}],"inputs":[{"at":1,"action":"move_forward","type":"down"},{"at":3,"action":"move_forward","type":"up"},{"at":3.2,"action":"interact"}],"probes":["Hero"],"captureAt":[4]}`,
  input: z
    .object({
      scene: z.string().optional().describe('Scene name (default: the main scene)'),
      seconds: z.number().positive().max(600).default(20),
      timeScale: z.number().positive().max(8).default(1),
      skipCutscenes: z.boolean().default(false),
      teleport: z
        .array(
          z.object({ at: z.number().min(0), entity: z.string(), position: Vec3, yaw: z.number().optional() }),
        )
        .default([]),
      inputs: z
        .array(
          z.object({
            at: z.number().min(0),
            action: z
              .string()
              .optional()
              .describe('move_forward, move_back, sprint, crouch, interact, skip, ...'),
            type: z.enum(['down', 'up', 'tap']).default('tap'),
            look: z
              .tuple([z.number(), z.number()])
              .optional()
              .describe('Mouse look delta in pixels [dx, dy]'),
          }),
        )
        .default([]),
      probes: z.array(z.string()).default([]).describe('Entities whose position is sampled every 0.5 s'),
      captureAt: z.array(z.number().min(0)).default([]).describe('Seconds at which to screenshot'),
      camera: z
        .object({ position: Vec3, target: Vec3, fov: z.number().default(60), at: z.number().default(0) })
        .optional()
        .describe('Fixed camera for screenshots (AIGE coordinates)'),
    })
    .strict(),
  async run(ctx, input) {
    const host = hostOf(ctx);
    const editor = requireUnity();
    const dir = host.fs.abs(UNITY_DIR);
    const name = (input.scene ?? host.state.project.startScene)
      .replace(/^.*\//, '')
      .replace(/\.(scene\.json|unity)$/, '');
    const scene = `Assets/Scenes/${name}.unity`;
    if (!existsSync(join(dir, scene)))
      throw new AigeError('INVALID_STATE', `The Unity scene ${scene} does not exist.`, {
        hint: 'Run unity_export first.',
      });
    if (await projectLocked(dir))
      throw new AigeError('INVALID_STATE', 'The Unity project is open in the editor.', {
        hint: 'Close the Unity editor, then try again.',
      });
    const out = host.fs.abs(`.aige/unity-tests/${Date.now()}`);
    await mkdir(out, { recursive: true });
    const testFile = join(out, 'test.json');
    const reportFile = join(out, 'report.json');
    const { scene: _scene, ...test } = input;
    await writeFile(testFile, JSON.stringify({ ...test, capturePrefix: join(out, 'shot') }));
    const run = await runUnity(
      editor.exe,
      dir,
      [
        '-executeMethod',
        'Aige.Editor.AigePlay.Run',
        '-aigeScene',
        scene,
        '-aigeTest',
        testFile,
        '-aigeReport',
        reportFile,
      ],
      {
        graphics: input.captureAt.length > 0,
        quit: false,
        logFile: join(out, 'unity.log'),
        timeoutMs: Math.max(5 * 60_000, (input.seconds / input.timeScale) * 4000 + 5 * 60_000),
      },
    );
    type Report = {
      ok?: boolean;
      errors?: string[];
      logs?: string[];
      events?: unknown[];
      probes?: Record<string, unknown[]>;
      final?: unknown;
      screenshots?: string[];
    };
    let report: Report | null = null;
    try {
      report = JSON.parse(await readFile(reportFile, 'utf8')) as Report;
    } catch {
      /* the harness did not finish */
    }
    if (!report)
      throw new AigeError('SCRIPT_ERROR', 'The Unity play-test did not produce a report.', {
        hint: logTail(run.log, 12) || 'Check that unity_export succeeded without C# errors.',
      });
    const images: ImageRef[] = [];
    for (const [i, abs] of (report.screenshots ?? []).entries()) {
      try {
        const bytes = await readFile(abs);
        const rel = `.aige/screenshots/unity-test-${Date.now()}-${i}.png`;
        await host.fs.write(rel, new Uint8Array(bytes));
        images.push({
          mimeType: 'image/png',
          data: bytes.toString('base64'),
          label: `t=${input.captureAt[i] ?? '?'}s`,
          path: rel,
        });
      } catch {
        /* missing screenshot is reported by the harness */
      }
    }
    return {
      ok: report.ok === true && !run.timedOut,
      errors: report.errors?.slice(0, 30) ?? [],
      events: report.events?.slice(0, 120) ?? [],
      final: report.final,
      probes: Object.fromEntries(
        Object.entries(report.probes ?? {}).map(([k, v]) => [
          k,
          v.filter((_, i) => i % 2 === 0).slice(0, 40),
        ]),
      ),
      logs: report.logs?.slice(-30) ?? [],
      ...(images.length ? { images } : {}),
    };
  },
});

export const unityCommands = [
  unityExportCmd,
  unityScreenshotCmd,
  unityPlayTestCmd,
  unityOpenCmd,
  unityStatusCmd,
];
