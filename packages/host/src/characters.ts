/**
 * Character tools: realistic skinned humans (character_create), the built-in clip library (animation_list) and
 * pose contact sheets of a clip on a character (animation_preview).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AigeError,
  BED_TOP,
  builtinClip,
  builtinClipNames,
  CLIP_ALIASES,
  canonicalClipName,
  compileClip,
  defineCommand,
  didYouMean,
  evaluatePoseState,
  forwardKinematics,
  hipsHeight,
  poseState,
  REFERENCE_HIPS_HEIGHT,
} from '@aige/core';
import { readGlbSkeleton, resolveHumanoidOptions } from '@aige/modeling';
import type { ViewSpec } from '@aige/render';
import { z } from 'zod';
import type { HostServices } from './commands.ts';

const host = (ctx: { services: unknown }) => (ctx.services as HostServices).host;
const TEMPLATES = resolve(import.meta.dirname, '..', '..', 'modeling', 'templates');
const NAME_RE = /^[a-z0-9][a-z0-9-_]*$/i;
const PRESETS = ['milch', 'murphy', 'parent', 'none'] as const;
const PARAM_KEYS = Object.keys(resolveHumanoidOptions({})).filter((k) => k !== 'seed');

const modelPathOf = (ref: string) => {
  const r = ref.replaceAll('\\', '/');
  return r.includes('/') || r.endsWith('.ts') || r.endsWith('.glb') ? r : `models/${r}.model.ts`;
};

function clipOrThrow(name: string): string {
  const canon = canonicalClipName(name);
  if (!canon) {
    throw new AigeError('NOT_FOUND', `Unknown animation clip '${name}'.`, {
      hint:
        didYouMean(name, [...builtinClipNames(), ...Object.keys(CLIP_ALIASES)]) ??
        'List the clips with animation_list.',
    });
  }
  return canon;
}

export const characterCreate = defineCommand({
  name: 'character_create',
  group: 'modeling',
  kind: 'mutation',
  tier: 'core',
  description: `Create a realistic, skinned and animated human character model (models/<name>.model.ts) and return a preview image. Start from a story preset (milch: 18-year-old slim male in a worn grey hoodie; murphy: 10-year-old boy in t-shirt and shorts; parent: adult in sweater and trousers; none: generic adult) and override any parameter: ${PARAM_KEYS.join(', ')}. The GLB has the AIGE humanoid skeleton (hips, spine, chest, neck, head, jaw, shoulder/upperarm/forearm/hand/fingers/thumb _l/_r, thigh/shin/foot/toe _l/_r), skin weights, sockets (hand_r, hand_l, head, eyes, belt, back) and every built-in clip as an animation (see animation_list). Use it with {"type":"MeshRenderer","model":"models/<name>.model.ts"} plus an Animator. Building takes ~10 s.
Example: {"name":"milch","preset":"milch"}`,
  input: z
    .object({
      name: z.string().regex(NAME_RE, 'Use letters, digits, - and _'),
      preset: z.enum(PRESETS).default('none'),
      params: z
        .record(z.string(), z.unknown())
        .default({})
        .describe('Overrides, e.g. {"height":1.8,"hairColor":"#3a2a20","top":"sweater"}'),
      preview: z.boolean().default(true),
    })
    .strict(),
  async run(ctx, input) {
    for (const k of Object.keys(input.params)) {
      if (k !== 'seed' && !PARAM_KEYS.includes(k)) {
        throw new AigeError('INVALID_INPUT', `character_create has no parameter '${k}'.`, {
          hint: didYouMean(k, PARAM_KEYS) ?? `Parameters: ${PARAM_KEYS.join(', ')}`,
        });
      }
    }
    const template = input.preset === 'none' ? 'human' : input.preset;
    const basePath = `models/templates/${template}.model.ts`;
    if (!(await ctx.readFile(basePath))) {
      await ctx.writeFile(basePath, readFileSync(resolve(TEMPLATES, `${template}.model.ts`), 'utf8'));
    }
    const path = `models/${input.name}.model.ts`;
    const src =
      Object.keys(input.params).length === 0
        ? `export { default } from './templates/${template}.model.ts';\n`
        : `import { withDefaults } from 'aige/model';
import base from './templates/${template}.model.ts';

/** ${input.name}: character based on the '${template}' template. */
export default withDefaults(base, ${JSON.stringify(input.params)}, { name: ${JSON.stringify(input.name)} });
`;
    await ctx.writeFile(path, src);
    const built = await host(ctx).assets.build(path, {});
    let images: unknown[] = [];
    if (input.preview) {
      try {
        const { image } = await host(ctx).render.modelPreview(
          path,
          {},
          {
            views: [{ kind: 'front' }, { kind: 'iso' }],
            size: 768,
          },
        );
        images = [image];
      } catch (err) {
        images = [];
        built.info.issues.push(`preview failed: ${(err as Error).message}`);
      }
    }
    return {
      model: path,
      usage: `{"type":"MeshRenderer","model":"${path}"} + {"type":"Animator","initial":"idle"}`,
      size: built.info.bounds.size,
      triangles: built.info.triangles,
      parts: built.info.parts,
      sockets: Object.keys(built.info.sockets),
      clips: builtinClipNames(),
      issues: built.info.issues,
      ...(images.length ? { images } : {}),
    };
  },
});

export const animationList = defineCommand({
  name: 'animation_list',
  group: 'modeling',
  kind: 'query',
  tier: 'core',
  description:
    'List the built-in humanoid animation clips (name, description, duration, loop, follow-up clip, events) and the accepted alias names. Every character from character_create carries them as glTF animations named by clip. Example: {}',
  input: z.object({}).strict(),
  async run() {
    return {
      clips: builtinClipNames().map((name) => {
        const c = builtinClip(name)!;
        return {
          name,
          description: c.description ?? '',
          duration: c.duration,
          loop: c.loop,
          ...(c.next ? { next: c.next } : {}),
          ...(c.setting && c.setting !== 'none' ? { setting: c.setting } : {}),
          ...(c.events?.length ? { events: c.events } : {}),
        };
      }),
      aliases: CLIP_ALIASES,
    };
  },
});

export const animationPreview = defineCommand({
  name: 'animation_preview',
  group: 'modeling',
  kind: 'action',
  tier: 'core',
  description:
    'Render a contact sheet of a character playing a clip: `frames` poses sampled evenly over the clip, side by side and labeled with their time. Use it to check that an animation reads well on a model. Example: {"model":"models/milch.model.ts","clip":"sit_up_bed","frames":6}',
  input: z
    .object({
      model: z.string().min(1).describe("Character model ('models/milch.model.ts' or just 'milch')"),
      clip: z.string().min(1).describe('Built-in clip name or alias (see animation_list)'),
      frames: z.number().int().min(1).max(12).default(6),
      view: z.enum(['auto', 'front', 'side', 'three_quarter', 'high']).default('auto'),
      params: z.record(z.string(), z.unknown()).default({}),
      width: z.number().int().min(256).max(2048).default(1280),
    })
    .strict(),
  async run(ctx, input) {
    const path = modelPathOf(input.model);
    const name = clipOrThrow(input.clip);
    const clip = builtinClip(name)!;
    const built = await host(ctx).assets.build(path, input.params);
    const skel = await readGlbSkeleton(built.glb);
    if (!skel) {
      throw new AigeError('INVALID_INPUT', `'${path}' is not a skinned character.`, {
        hint: 'Create one with character_create (or use a model built with humanoid()).',
      });
    }
    const compiled = compileClip(clip);
    const n = input.frames;
    const times = Array.from({ length: n }, (_, i) =>
      n === 1 ? 0 : clip.loop ? (i / n) * clip.duration : (i / (n - 1)) * clip.duration,
    );
    // lay the frames out left to right using each pose's joint extent
    const k = hipsHeight(skel) / REFERENCE_HIPS_HEIGHT;
    const H = Math.max(...skel.joints.map((j) => j.position[1])) + 0.12 * k;
    const gap = 0.22 * k;
    let cursor = 0;
    let maxY = H;
    const frames = times.map((t) => {
      const pose = evaluatePoseState(poseState(name, t), (c) => (c === name ? compiled : null));
      const fk = forwardKinematics(skel, {
        rot: pose.rot,
        hips: [pose.hips[0] * k, pose.hips[1] * k, pose.hips[2] * k],
      });
      let lo = Infinity;
      let hi = -Infinity;
      for (const j of fk.values()) {
        lo = Math.min(lo, j.pos[0]);
        hi = Math.max(hi, j.pos[0]);
        maxY = Math.max(maxY, j.pos[1] + 0.15 * k);
      }
      lo -= 0.16 * k;
      hi += 0.16 * k;
      const x = cursor - lo;
      cursor = x + hi + gap;
      return { clip: name, time: t, label: `${t.toFixed(2)}s`, x };
    });
    const total = cursor - gap;
    const center = total / 2;
    const setting = clip.setting ?? 'none';
    const view = input.view === 'auto' ? (setting === 'none' ? 'three_quarter' : 'high') : input.view;
    const dir: [number, number, number] =
      view === 'front'
        ? [0, 0.08, 1]
        : view === 'side'
          ? [1, 0.08, 0]
          : view === 'high'
            ? [0.35, 0.75, 1]
            : [0.45, 0.18, 1];
    const width = input.width;
    const height = Math.round(Math.min(width, Math.max(360, (width * maxY * 1.25) / Math.max(total, 0.5))));
    const aspect = width / height;
    const fov = 18;
    const tv = Math.tan(((fov / 2) * Math.PI) / 180);
    const dist = Math.max((maxY * 0.62) / tv, (total * 0.56) / (tv * aspect)) * 1.05;
    const l = Math.hypot(...dir);
    const target: [number, number, number] = [center, maxY * 0.45, setting === 'bed' ? -0.4 * k : 0];
    const cam: ViewSpec = {
      kind: 'custom',
      position: [
        target[0] + (dir[0] / l) * dist,
        target[1] + (dir[1] / l) * dist,
        target[2] + (dir[2] / l) * dist,
      ],
      target,
      fov,
      label: `${name}${clip.loop ? ' (loop)' : ''}`,
    };
    const bedTop = BED_TOP * k;
    // one long mattress under every frame (a single wide prop also stays unlabeled)
    const props =
      setting === 'bed'
        ? [
            {
              position: [center, bedTop / 2, -0.78 * k] as [number, number, number],
              size: [total + 0.6 * k, bedTop, 0.95 * k] as [number, number, number],
              color: '#7a6b5c',
            },
          ]
        : [];
    const { image } = await host(ctx).render.modelPoses(path, input.params, frames, {
      view: cam,
      width,
      height,
      title: `${path} - ${name}`,
      props,
    });
    return {
      model: path,
      clip: name,
      duration: clip.duration,
      loop: clip.loop,
      times: times.map((t) => Math.round(t * 100) / 100),
      images: [image],
    };
  },
});

export const characterCommands = [characterCreate, animationList, animationPreview];
