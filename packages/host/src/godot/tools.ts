import { readFile } from 'node:fs/promises';
import { AigeError, defineCommand, type ImageRef } from '@aige/core';
import { z } from 'zod';
import type { ProjectHost } from '../host.ts';
import { godotCriticCmd } from './critic.ts';
import { exportGodot } from './export.ts';
import {
  captureShots,
  dotnetBuild,
  type GodotTest,
  godotInstalled,
  openGodotEditor,
  runGodotTest,
} from './runner.ts';

type Services = { host: ProjectHost };
const hostOf = (ctx: { services: unknown }) => (ctx.services as Services).host;

const requireGodot = () => {
  if (!godotInstalled())
    throw new AigeError('UNSUPPORTED', 'Godot 4 .NET is not installed.', {
      hint: 'Run `aige godot setup` (downloads ~120 MB).',
    });
};

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const godotExportCmd = defineCommand({
  name: 'godot_export',
  group: 'godot',
  kind: 'action',
  tier: 'core',
  description: `Export the game to Godot 4 .NET (the game runtime; game code is C#). Writes project.godot, the C# project, addons/aige (AIGE runtime: Story, Hud, Voice, Cutscenes, components), bakes every model to GLB with its PBR materials, bakes ambience/SFX audio, writes one .tscn per scene, then runs \`dotnet build\` and Godot's asset import. Re-run after changing scenes, models or materials; it only rewrites what changed. Returns C# compile errors as file:line.
Example: {"main":"house"}`,
  input: z
    .object({
      main: z.string().optional().describe('Start scene name or path (default: project startScene)'),
      build: z.boolean().default(true),
      import: z.boolean().default(true),
    })
    .strict(),
  async run(ctx, input) {
    const r = await exportGodot(hostOf(ctx), input);
    return {
      ...r,
      warnings: r.warnings.slice(0, 40),
      next:
        r.build && !r.build.ok
          ? 'Fix the C# errors (csharp_write), then godot_export again.'
          : 'godot_screenshot to look at it, godot_play_test to play-test it.',
    };
  },
});

const TestInput = z.object({
  scene: z.string().optional().describe('Scene name (default: the main scene)'),
  seconds: z.number().positive().max(600).default(20),
  timeScale: z.number().positive().max(8).default(1).describe('Run faster than real time (headless only)'),
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
          .describe('move_forward, move_back, move_left, move_right, sprint, crouch, interact, skip, ...'),
        type: z.enum(['down', 'up', 'tap']).default('tap'),
        look: z.tuple([z.number(), z.number()]).optional().describe('Mouse look delta in pixels [dx, dy]'),
      }),
    )
    .default([]),
  probes: z.array(z.string()).default([]).describe('Entities whose position is sampled every 0.5 s'),
  captureAt: z
    .array(z.number().min(0))
    .default([])
    .describe('Seconds at which to screenshot (runs with a window)'),
  camera: z
    .object({ position: Vec3, target: Vec3, fov: z.number().default(60), at: z.number().default(0) })
    .optional()
    .describe('Fixed camera for screenshots'),
});

async function playTest(host: ProjectHost, input: z.output<typeof TestInput>, quitAfterCaptures = false) {
  requireGodot();
  if (!(await host.fs.exists('project.godot')))
    throw new AigeError('INVALID_STATE', 'The game has not been exported to Godot yet.', {
      hint: 'Run godot_export first.',
    });
  const scene = input.scene
    ? `res://godot/scenes/${input.scene.replace(/^.*\//, '').replace(/\.(scene\.json|tscn)$/, '')}.tscn`
    : undefined;
  const test: GodotTest = {
    seconds: input.seconds,
    timeScale: input.timeScale,
    skipCutscenes: input.skipCutscenes,
    teleport: input.teleport,
    inputs: input.inputs,
    probes: input.probes,
    captureAt: input.captureAt,
    ...(input.camera ? { camera: input.camera } : {}),
    ...(quitAfterCaptures ? { quitAfterCaptures: true } : {}),
  };
  const { report, timedOut } = await runGodotTest(host.root, test, scene ? { scene } : {});
  const images: ImageRef[] = [];
  for (const [i, abs] of (report.screenshots ?? []).entries()) {
    try {
      const bytes = await readFile(abs);
      const rel = `.aige/screenshots/godot-${Date.now()}-${i}.png`;
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
  return { report, timedOut, images };
}

export const godotPlayTestCmd = defineCommand({
  name: 'godot_play_test',
  group: 'godot',
  kind: 'action',
  tier: 'core',
  description: `Play-test the exported Godot game with scripted input and get a report: story events (flags, interactions, doors, triggers, cutscenes, voice lines, objectives), probe tracks, final state, C# errors, and screenshots at captureAt times. Headless (fast) unless captureAt is set. Run godot_export first after changes.
Example: {"seconds":25,"teleport":[{"at":0,"entity":"Hero","position":[0,0,2],"yaw":180}],"inputs":[{"at":1,"action":"move_forward","type":"down"},{"at":3,"action":"move_forward","type":"up"},{"at":3.2,"action":"interact"}],"probes":["Hero"],"captureAt":[4]}`,
  input: TestInput.strict(),
  async run(ctx, input) {
    const { report, timedOut, images } = await playTest(hostOf(ctx), input);
    const probes = Object.fromEntries(
      Object.entries(report.probes ?? {}).map(([k, v]) => [k, v.filter((_, i) => i % 2 === 0).slice(0, 40)]),
    );
    return {
      ok: report.ok && !timedOut,
      errors: report.errors?.slice(0, 30) ?? [],
      events: report.events?.slice(0, 120) ?? [],
      final: report.final,
      probes,
      logs: report.logs?.slice(-30) ?? [],
      ...(images.length ? { images } : {}),
    };
  },
});

export const godotScreenshotCmd = defineCommand({
  name: 'godot_screenshot',
  group: 'godot',
  kind: 'action',
  tier: 'core',
  description: `Render the exported game in Godot (the real, final look: GI, fog, shadows, post effects) and return images. Give \`views\` (camera position + target) to frame shots, several per call; this works even when the game's C# doesn't compile. Without views it plays the game and captures the gameplay camera at time \`at\`.
Example: {"scene":"house","views":[{"position":[2,1.6,3],"target":[0,1,0],"fov":65},{"position":[-3,1.6,-1],"target":[-4,0.8,-3]}]}`,
  input: z
    .object({
      scene: z.string().optional(),
      views: z
        .array(z.object({ position: Vec3, target: Vec3, fov: z.number().default(65) }))
        .max(8)
        .optional(),
      camera: z.object({ position: Vec3, target: Vec3, fov: z.number().default(60) }).optional(),
      at: z.number().min(0.1).max(60).default(1.5),
      skipCutscenes: z.boolean().default(true),
      width: z.number().int().min(320).max(1920).default(1280),
    })
    .strict(),
  async run(ctx, input) {
    const host = hostOf(ctx);
    const views = input.views ?? (input.camera ? [input.camera] : null);
    if (views) {
      requireGodot();
      const state = host.state;
      const sceneName = (input.scene ?? state.project.startScene)
        .replace(/^.*\//, '')
        .replace(/\.(scene\.json|tscn)$/, '');
      const height = Math.round((input.width * 9) / 16);
      const { files, errors } = await captureShots(host.root, `res://godot/scenes/${sceneName}.tscn`, views, {
        resolution: `${input.width}x${height}`,
      });
      if (!files.length)
        throw new AigeError('RENDER_FAILED', 'Godot did not produce a screenshot.', {
          hint: errors.slice(0, 5).join(' | ') || 'Run godot_export first.',
        });
      const images: ImageRef[] = [];
      for (const [i, abs] of files.entries()) {
        const bytes = await readFile(abs);
        const rel = `.aige/screenshots/godot-${Date.now()}-${i}.png`;
        await host.fs.write(rel, new Uint8Array(bytes));
        images.push({
          mimeType: 'image/png',
          data: bytes.toString('base64'),
          label: `view ${i + 1}`,
          path: rel,
        });
      }
      return { images, errors };
    }
    const { report, images } = await playTest(
      hostOf(ctx),
      TestInput.parse({
        scene: input.scene,
        seconds: input.at + 30,
        skipCutscenes: input.skipCutscenes,
        captureAt: [input.at],
        ...(input.camera ? { camera: { ...input.camera, at: 0 } } : {}),
      }),
      true,
    );
    if (!images.length)
      throw new AigeError('RENDER_FAILED', 'Godot did not produce a screenshot.', {
        hint: (report.errors ?? []).slice(0, 5).join(' | ') || 'Check that godot_export succeeded.',
      });
    return { images, errors: report.errors?.slice(0, 10) ?? [] };
  },
});

export const csharpWriteCmd = defineCommand({
  name: 'csharp_write',
  group: 'godot',
  kind: 'mutation',
  tier: 'core',
  description: `Write a C# game script (scripts/*.cs, Godot 4 .NET) and compile the game with dotnet; returns compile errors as file:line. The class name must match the file name and be \`public partial class X : <GodotType>\`. Attach it with a Script component {script:'scripts/X.cs', props:{...}} (props = its [Export] members). The AIGE C# API (Story, Hud, Voice, Cutscenes, Sfx, components) is in addons/aige/API.md (api_docs topic 'godot').
Example: {"path":"scripts/FridgeHum.cs","content":"using Godot;\\nusing Aige;\\n\\npublic partial class FridgeHum : Node3D\\n{\\n    public override void _Ready() => Story.Emit(\\"fridge_seen\\");\\n}\\n"}`,
  input: z
    .object({
      path: z.string().regex(/^scripts\/[\w/-]+\.cs$/, "Use 'scripts/<Name>.cs'"),
      content: z.string().min(1),
      build: z.boolean().default(true),
    })
    .strict(),
  async run(ctx, input) {
    const host = hostOf(ctx);
    await ctx.writeFile(input.path, input.content);
    if (!input.build) return { path: input.path };
    if (!(await host.fs.exists('project.godot')))
      return { path: input.path, note: 'Not compiled yet: run godot_export once to create the C# project.' };
    const b = await dotnetBuild(host.root);
    return {
      path: input.path,
      ok: b.ok,
      errors: b.errors.slice(0, 30),
      warningsInFile: b.warnings.filter((w) => w.file === input.path).slice(0, 10),
      ...(b.ok ? {} : { log: b.errors.length ? undefined : b.log }),
    };
  },
});

export const godotOpenCmd = defineCommand({
  name: 'godot_open',
  group: 'godot',
  kind: 'action',
  tier: 'extended',
  description:
    'Open the exported project in the Godot editor (for the human to look around, play with F5, or tweak). Example: {}',
  input: z.object({}).strict(),
  async run(ctx) {
    requireGodot();
    const host = hostOf(ctx);
    if (!(await host.fs.exists('project.godot')))
      throw new AigeError('INVALID_STATE', 'Not exported yet.', { hint: 'Run godot_export first.' });
    openGodotEditor(host.root);
    return { opened: host.root };
  },
});

export const godotCommands = [
  godotExportCmd,
  godotPlayTestCmd,
  godotScreenshotCmd,
  csharpWriteCmd,
  godotOpenCmd,
  godotCriticCmd,
];
