import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AigeError,
  type CommandBus,
  defineCommand,
  didYouMean,
  getScene,
  type ImageRef,
  toolDefinitions,
} from '@aige/core';
import type { ParamDef } from '@aige/modeling';
import * as modeling from '@aige/modeling';
import type { ViewKind, ViewSpec } from '@aige/render';
import { builtinBehaviours } from '@aige/runtime';
import { z } from 'zod';
import { assetCommands } from './assets/polyhaven.ts';
import { characterCommands } from './characters.ts';
import { CONVENTIONS, componentsDoc, DOC_TOPICS, MODELING, OVERVIEW, SCRIPTING, toolsDoc } from './docs.ts';
import { exportWebCommand } from './export.ts';
import { godotCommands } from './godot/tools.ts';
import type { ProjectHost } from './host.ts';
import { gameRunHeadless } from './play.ts';
import { compileUserModule, runModule } from './sandbox.ts';
import { scriptingCommands } from './scripting.ts';
import { voiceCommands } from './voice/voice-tools.ts';

export interface HostServices {
  bus: CommandBus<HostServices>;
  host: ProjectHost;
}

const host = (ctx: { services: unknown }) => (ctx.services as HostServices).host;

export const TEMPLATE_DIR = resolve(import.meta.dirname, '..', '..', 'modeling', 'templates');

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------

export interface TemplateInfo {
  name: string;
  description: string;
  params: Record<string, ParamDef>;
  source: string;
}

let templateCache: Promise<TemplateInfo[]> | null = null;

export function listTemplates(): Promise<TemplateInfo[]> {
  templateCache ??= (async () => {
    const out: TemplateInfo[] = [];
    for (const file of readdirSync(TEMPLATE_DIR)
      .filter((f) => f.endsWith('.model.ts'))
      .sort()) {
      const entry = join(TEMPLATE_DIR, file);
      const compiled = await compileUserModule({
        entry,
        root: TEMPLATE_DIR,
        virtuals: { 'aige/model': '__aigeModel' },
      });
      const { exports } = runModule(compiled, { filename: file, globals: { __aigeModel: modeling } });
      const recipe = exports.default;
      out.push({
        name: file.replace('.model.ts', ''),
        description: recipe.description ?? '',
        params: recipe.params ?? {},
        source: readFileSync(entry, 'utf8'),
      });
    }
    return out;
  })();
  return templateCache;
}

/** Template names (sync, for tool descriptions). */
function templateNames(): string[] {
  try {
    return readdirSync(TEMPLATE_DIR)
      .filter((f) => f.endsWith('.model.ts'))
      .map((f) => f.replace('.model.ts', ''))
      .sort();
  } catch {
    return [];
  }
}

function paramSummary(params: Record<string, ParamDef>): string {
  return Object.entries(params)
    .map(
      ([k, d]) =>
        `${k}=${JSON.stringify(d.default)}${d.type === 'choice' ? ` (${d.options.join('|')})` : ''}`,
    )
    .join(', ');
}

// ---------------------------------------------------------------------------------------------
// Shared inputs
// ---------------------------------------------------------------------------------------------

const VIEW_KINDS = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom', 'camera'] as const;
const ViewsInput = z
  .array(z.enum(VIEW_KINDS))
  .min(1)
  .max(6)
  .optional()
  .describe("Views to render, e.g. ['camera','iso'] or ['front','right']");
const toViews = (v?: readonly string[]): ViewSpec[] | undefined =>
  v?.map((kind) => ({ kind: kind as ViewKind }));
const ModelRef = z
  .string()
  .min(1)
  .describe("Model path ('models/coin.model.ts' or a '.glb') or just the name ('coin')");
const Params = z.record(z.string(), z.unknown()).default({}).describe('Recipe parameter overrides');

export function modelPath(ref: string): string {
  const r = ref.replaceAll('\\', '/');
  if (r.includes('/') || r.endsWith('.ts') || r.endsWith('.glb')) return r;
  return `models/${r}.model.ts`;
}

const NAME_RE = /^[a-z0-9][a-z0-9-_]*$/i;

const MANAGED_JSON = /(^project\.json$|\.scene\.json$|\.material\.json$|\.prefab\.json$)/;

// ---------------------------------------------------------------------------------------------
// Project & files
// ---------------------------------------------------------------------------------------------

export const projectInfo = defineCommand({
  name: 'project_info',
  group: 'project',
  kind: 'query',
  tier: 'core',
  description:
    'Overview of the open project: name, root folder, scenes, models, scripts, materials, prefabs, and the render backend.',
  input: z.object({}).strict(),
  async run(ctx) {
    const h = host(ctx);
    const s = ctx.state;
    const files = await h.fs.list('');
    return {
      name: s.project.name,
      root: h.root,
      activeScene: s.activeScene,
      startScene: s.project.startScene,
      scenes: Object.entries(s.scenes).map(([p, d]) => `${p} (${d.entities.length} entities)`),
      models: files.filter((f) => f.startsWith('models/') && (f.endsWith('.model.ts') || f.endsWith('.glb'))),
      scripts: files.filter((f) => f.startsWith('scripts/') && f.endsWith('.ts')),
      materials: Object.keys(s.materials),
      prefabs: Object.keys(s.prefabs),
      render: h.render.backendName,
    };
  },
});

export const fileList = defineCommand({
  name: 'file_list',
  group: 'project',
  kind: 'query',
  tier: 'extended',
  description: 'List project files (recursively). Example: {"dir":"scripts"}',
  input: z
    .object({ dir: z.string().default(''), pattern: z.string().optional().describe('Regex filter') })
    .strict(),
  async run(ctx, input) {
    const files = await host(ctx).fs.list(
      input.dir,
      input.pattern ? { pattern: new RegExp(input.pattern) } : {},
    );
    return { files: files.slice(0, 500), total: files.length };
  },
});

export const fileRead = defineCommand({
  name: 'file_read',
  group: 'project',
  kind: 'query',
  tier: 'extended',
  description: 'Read a text file from the project (with line numbers). Example: {"path":"scripts/player.ts"}',
  input: z
    .object({
      path: z.string().min(1),
      offset: z.number().int().min(1).default(1).describe('First line (1-based)'),
      limit: z.number().int().min(1).max(5000).default(800),
      raw: z.boolean().default(false).describe('Return the whole file without line numbers'),
    })
    .strict(),
  async run(ctx, input) {
    const text = await ctx.readFile(input.path);
    if (text === null) {
      const files = await host(ctx).fs.list('');
      throw new AigeError('NOT_FOUND', `File '${input.path}' not found.`, {
        hint: didYouMean(input.path, files),
      });
    }
    if (input.raw) return { path: input.path, content: text };
    const lines = text.split('\n');
    const slice = lines.slice(input.offset - 1, input.offset - 1 + input.limit);
    return {
      path: input.path,
      totalLines: lines.length,
      content: slice.map((l, i) => `${String(input.offset + i).padStart(4)}  ${l}`).join('\n'),
    };
  },
});

export const fileWrite = defineCommand({
  name: 'file_write',
  group: 'project',
  kind: 'mutation',
  tier: 'extended',
  description:
    'Write a text file in the project (overwrites). For scripts prefer script_write, for models model_create (they compile and check your code). Scene/material/prefab JSON is managed by the scene tools and cannot be written directly.',
  input: z.object({ path: z.string().min(1), content: z.string() }).strict(),
  async run(ctx, input) {
    const p = input.path.replaceAll('\\', '/');
    if (MANAGED_JSON.test(p)) {
      throw new AigeError('INVALID_INPUT', `'${p}' is managed by AIGE.`, {
        hint: 'Use entity_*/component_*/material_*/prefab_*/project_settings tools instead.',
      });
    }
    if (p.startsWith('.aige/')) throw new AigeError('INVALID_INPUT', '.aige/ is internal.');
    await ctx.writeFile(p, input.content);
    return { path: p, bytes: input.content.length };
  },
});

export const fileDelete = defineCommand({
  name: 'file_delete',
  group: 'project',
  kind: 'mutation',
  tier: 'extended',
  description: 'Delete a project file (undoable). Example: {"path":"models/old.model.ts"}',
  input: z.object({ path: z.string().min(1) }).strict(),
  async run(ctx, input) {
    if (MANAGED_JSON.test(input.path))
      throw new AigeError('INVALID_INPUT', `Use the scene/material/prefab tools to delete '${input.path}'.`);
    if ((await ctx.readFile(input.path)) === null)
      throw new AigeError('NOT_FOUND', `File '${input.path}' not found.`);
    await ctx.deleteFile(input.path);
    return { deleted: input.path };
  },
});

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

async function previewOrWarn(
  ctx: { services: unknown },
  path: string,
  params: Record<string, unknown>,
  views?: ViewSpec[],
): Promise<{ images?: ImageRef[]; previewWarning?: string }> {
  try {
    const { image } = await host(ctx).render.modelPreview(path, params, views ? { views } : {});
    return { images: [image] };
  } catch (err) {
    return { previewWarning: `Preview unavailable: ${(err as Error).message}` };
  }
}

export const modelTemplates = defineCommand({
  name: 'model_templates',
  group: 'modeling',
  kind: 'query',
  tier: 'extended',
  description: 'List the built-in model templates with their descriptions and parameters.',
  input: z.object({ source: z.boolean().default(false).describe('Include the recipe source code') }).strict(),
  async run(_ctx, input) {
    const list = await listTemplates();
    return {
      templates: list.map((t) => ({
        name: t.name,
        description: t.description,
        params: paramSummary(t.params),
        ...(input.source ? { source: t.source } : {}),
      })),
    };
  },
});

export const modelFromTemplate = defineCommand({
  name: 'model_from_template',
  group: 'modeling',
  kind: 'mutation',
  tier: 'core',
  description: `Create a model asset from a built-in template, optionally with new default parameters, and return a preview image. The model is saved as models/<name>.model.ts. Templates: ${templateNames().join(', ')}.
Example: {"template":"coin","name":"silver-coin","params":{"color":"#c0c0c0","radius":0.3}}`,
  input: z
    .object({
      template: z.string().min(1),
      name: z.string().regex(NAME_RE, 'Use letters, digits, - and _').optional(),
      params: z.record(z.string(), z.unknown()).default({}).describe('New default parameter values'),
      preview: z.boolean().default(true),
    })
    .strict(),
  async run(ctx, input) {
    const templates = await listTemplates();
    const t = templates.find((x) => x.name === input.template);
    if (!t) {
      throw new AigeError('NOT_FOUND', `Unknown template '${input.template}'.`, {
        hint:
          didYouMean(
            input.template,
            templates.map((x) => x.name),
          ) ?? `Templates: ${templates.map((x) => x.name).join(', ')}`,
      });
    }
    for (const k of Object.keys(input.params)) {
      if (k !== 'seed' && !(k in t.params)) {
        throw new AigeError('INVALID_INPUT', `Template '${t.name}' has no parameter '${k}'.`, {
          hint: `Parameters: ${paramSummary(t.params)}`,
        });
      }
    }
    const name = input.name ?? t.name;
    const path = `models/${name}.model.ts`;
    const basePath = `models/templates/${t.name}.model.ts`;
    if (!(await ctx.readFile(basePath))) await ctx.writeFile(basePath, t.source);
    if (name === t.name && Object.keys(input.params).length === 0) {
      // plain copy is enough: re-export the template
      await ctx.writeFile(path, `export { default } from './templates/${t.name}.model.ts';\n`);
    } else {
      const src = `import { withDefaults } from 'aige/model';
import base from './templates/${t.name}.model.ts';

/** ${name}: variant of the '${t.name}' template. */
export default withDefaults(base, ${JSON.stringify(input.params)}, { name: ${JSON.stringify(name)} });
`;
      await ctx.writeFile(path, src);
    }
    const built = await host(ctx).assets.build(path, {});
    const preview = input.preview ? await previewOrWarn(ctx, path, {}) : {};
    return {
      model: path,
      usage: `{"type":"MeshRenderer","model":"${path}"}`,
      size: built.info.bounds.size,
      triangles: built.info.triangles,
      params: paramSummary(built.info.paramDefs),
      sockets: Object.keys(built.info.sockets),
      collider: built.info.collider,
      issues: built.info.issues,
      ...preview,
    };
  },
});

export const modelCreate = defineCommand({
  name: 'model_create',
  group: 'modeling',
  kind: 'mutation',
  tier: 'core',
  description: `Write a procedural model recipe (TypeScript) to models/<name>.model.ts, build it, and return a multi-view preview image plus size, triangle count and mesh issues. The source must \`export default defineModel({...})\` and import from 'aige/model'. Overwrites an existing model with the same name. Read api_docs topic 'modeling' for the full API.
Example: {"name":"mushroom","source":"import { defineModel, p, cylinder, sphere, model } from 'aige/model';\\nexport default defineModel({ params: { cap: p.color('#d63b3b') }, build: ({ cap }) => model({ stem: cylinder({ radius: 0.12, height: 0.5 }).translate([0, 0.25, 0]).material({ color: '#f0e6d2' }), cap: sphere({ radius: 0.35 }).scale([1, 0.6, 1]).translate([0, 0.55, 0]).material({ color: cap }) }) });"}`,
  input: z
    .object({
      name: z.string().regex(NAME_RE, 'Use letters, digits, - and _'),
      source: z.string().min(20),
      params: Params,
      preview: z.boolean().default(true),
      views: ViewsInput,
    })
    .strict(),
  async run(ctx, input) {
    const path = `models/${input.name}.model.ts`;
    await ctx.writeFile(path, input.source);
    const built = await host(ctx).assets.build(path, input.params);
    const preview = input.preview ? await previewOrWarn(ctx, path, input.params, toViews(input.views)) : {};
    return {
      model: path,
      usage: `{"type":"MeshRenderer","model":"${path}"}`,
      size: built.info.bounds.size,
      bounds: built.info.bounds,
      triangles: built.info.triangles,
      parts: built.info.parts,
      params: paramSummary(built.info.paramDefs),
      sockets: Object.keys(built.info.sockets),
      collider: built.info.collider,
      issues: built.info.issues,
      ...(built.info.logs.length ? { logs: built.info.logs.slice(0, 20) } : {}),
      buildMs: built.info.buildMs,
      ...preview,
    };
  },
});

export const modelInfo = defineCommand({
  name: 'model_info',
  group: 'modeling',
  kind: 'query',
  tier: 'extended',
  description:
    'Build a model (cached) and report its size, bounds, triangles, parameters, sockets, collider hint and mesh issues. Example: {"model":"coin","params":{"radius":0.6}}',
  input: z.object({ model: ModelRef, params: Params }).strict(),
  async run(ctx, input) {
    const built = await host(ctx).assets.build(modelPath(input.model), input.params);
    const { key: _k, ...info } = built.info;
    return { ...info, paramsSummary: paramSummary(built.info.paramDefs) };
  },
});

export const modelPreview = defineCommand({
  name: 'model_preview',
  group: 'modeling',
  kind: 'action',
  tier: 'core',
  description:
    'Render a model in a studio scene from several angles (default: iso, front, right, top) with a grid and dimensions, and return the image. Example: {"model":"coin","params":{"color":"#ff0000"},"views":["front","iso"]}',
  input: z
    .object({
      model: ModelRef,
      params: Params,
      views: ViewsInput,
      size: z.number().int().min(128).max(2048).default(1024),
      save: z.boolean().default(true).describe('Also save the PNG under .aige/screenshots'),
    })
    .strict(),
  async run(ctx, input) {
    const views = toViews(input.views);
    const { image, info } = await host(ctx).render.modelPreview(modelPath(input.model), input.params, {
      size: input.size,
      save: input.save,
      ...(views ? { views } : {}),
    });
    return {
      model: info.path,
      size: info.bounds.size,
      triangles: info.triangles,
      issues: info.issues,
      images: [image],
    };
  },
});

export const modelExportGlb = defineCommand({
  name: 'model_export_glb',
  group: 'modeling',
  kind: 'action',
  tier: 'extended',
  description:
    'Export a model as a .glb file inside the project (for other tools like Blender). Example: {"model":"crate","path":"exports/crate.glb"}',
  input: z.object({ model: ModelRef, params: Params, path: z.string().optional() }).strict(),
  async run(ctx, input) {
    const mp = modelPath(input.model);
    const built = await host(ctx).assets.build(mp, input.params);
    const out =
      input.path ??
      `exports/${mp
        .split('/')
        .pop()!
        .replace(/\.model\.ts$/, '')}.glb`;
    await host(ctx).fs.write(out, built.glb);
    return { path: out, bytes: built.glb.byteLength, triangles: built.info.triangles };
  },
});

export const textureGenerate = defineCommand({
  name: 'texture_generate',
  group: 'material',
  kind: 'action',
  tier: 'extended',
  description:
    'Generate a tileable procedural texture PNG (textures/<name>.png) for material maps. Kinds: checker, noise, grid, bricks, stripes, dots, wood, marble. Then set it on a material: material_create {"name":"bricks","map":"textures/bricks.png","mapRepeat":[4,4]}. Example: {"name":"bricks","kind":"bricks","colorA":"#b5563c","colorB":"#d8cfc4","scale":6}',
  input: z
    .object({
      name: z.string().regex(NAME_RE, 'Use letters, digits, - and _'),
      kind: z.enum(['checker', 'noise', 'grid', 'bricks', 'stripes', 'dots', 'wood', 'marble']),
      colorA: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default('#ffffff'),
      colorB: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default('#808080'),
      scale: z.number().positive().max(64).default(4).describe('Pattern repetitions across the texture'),
      size: z.number().int().min(16).max(1024).default(256),
      seed: z.number().int().default(7),
    })
    .strict(),
  async run(ctx, input) {
    const img = modeling.proceduralTexture(input);
    const path = `textures/${input.name}.png`;
    await host(ctx).fs.write(path, modeling.encodePng(img));
    return {
      path,
      size: [img.width, img.height],
      usage: `{"map":"${path}","mapRepeat":[4,4]} in material_create`,
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Rendering & validation
// ---------------------------------------------------------------------------------------------

export const renderScreenshot = defineCommand({
  name: 'render_screenshot',
  group: 'verify',
  kind: 'action',
  tier: 'core',
  description:
    'Render the scene and return an image. Default views are the game camera + an isometric overview, with entity id/name labels so you can match what you see to entities. Look at it critically: floating objects, wrong scale, missing models (magenta boxes), bad lighting. Example: {"views":["camera","top"],"focus":["Player"]}',
  input: z
    .object({
      scene: z.string().optional(),
      views: ViewsInput,
      width: z.number().int().min(256).max(2048).optional(),
      height: z.number().int().min(256).max(2048).optional(),
      labels: z.boolean().default(true),
      grid: z.boolean().default(false),
      focus: z.array(z.string()).optional().describe('Entities to frame in non-camera views'),
    })
    .strict(),
  async run(ctx, input) {
    const views = toViews(input.views);
    const { image, result, warnings } = await host(ctx).render.screenshot({
      ...(input.scene ? { scene: input.scene } : {}),
      ...(views ? { views } : {}),
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
      labels: input.labels,
      grid: input.grid,
      ...(input.focus ? { focus: input.focus } : {}),
    });
    return {
      views: result.views,
      triangles: result.stats.triangles,
      sceneBounds: result.stats.bounds,
      ...(warnings.length ? { warnings } : {}),
      images: [image],
    };
  },
});

const BUILTIN_SCRIPTS = Object.keys(builtinBehaviours);

export const sceneValidate = defineCommand({
  name: 'scene_validate',
  group: 'verify',
  kind: 'query',
  tier: 'core',
  description:
    'Check the scene for problems: missing camera or lights, bodies without colliders, missing model/script/material files, models that fail to build, unknown built-in scripts, entities below the kill height, duplicate UI ids. Run it before play-testing.',
  input: z.object({ scene: z.string().optional(), buildModels: z.boolean().default(true) }).strict(),
  async run(ctx, input) {
    const h = host(ctx);
    const state = ctx.state;
    const scene = getScene(state, input.scene);
    const errors: string[] = [];
    const warnings: string[] = [];
    const label = (e: { id: string; name: string }) => `${e.id} '${e.name}'`;
    const cams = scene.entities.filter((e) => e.active && e.components.some((c) => c.type === 'Camera'));
    if (cams.length === 0) errors.push('No active Camera entity: the game has no viewpoint.');
    const lights = scene.entities.filter((e) => e.components.some((c) => c.type === 'Light'));
    if (lights.length === 0 && scene.settings.environment === 'none')
      warnings.push('No lights and environment "none": the scene will be dark.');
    const uiIds = new Map<string, string>();
    const files = new Set(await h.fs.list(''));
    const modelsToBuild = new Map<string, { params: Record<string, unknown>; who: string }>();
    let hasPlayerController = false;
    for (const e of scene.entities) {
      const types = e.components.map((c) => c.type);
      if (types.includes('RigidBody') && !types.includes('Collider'))
        warnings.push(`${label(e)} has a RigidBody but no Collider.`);
      if (types.includes('RigidBody') && types.includes('CharacterController'))
        warnings.push(`${label(e)} has both RigidBody and CharacterController; remove the RigidBody.`);
      for (const c of e.components) {
        if (c.type === 'MeshRenderer') {
          if (c.model) {
            const mp = c.model as string;
            if (!files.has(mp)) errors.push(`${label(e)}: model file '${mp}' does not exist.`);
            else
              modelsToBuild.set(`${mp}|${JSON.stringify(c.params ?? {})}`, {
                params: (c.params as Record<string, unknown>) ?? {},
                who: label(e),
              });
          } else if (!c.primitive)
            warnings.push(`${label(e)}: MeshRenderer has neither model nor primitive (renders a white box).`);
          if (c.material && !state.materials[c.material as string])
            errors.push(`${label(e)}: material '${c.material}' does not exist.`);
        }
        if (c.type === 'Script') {
          const s = c.script as string;
          if (s.startsWith('builtin:')) {
            const n = s.slice(8);
            if (!BUILTIN_SCRIPTS.includes(n))
              errors.push(
                `${label(e)}: unknown built-in script '${s}'. ${didYouMean(n, BUILTIN_SCRIPTS) ?? `Built-ins: ${BUILTIN_SCRIPTS.join(', ')}`}`,
              );
            if (n === 'PlayerController') {
              hasPlayerController = true;
              if (!types.includes('CharacterController'))
                warnings.push(
                  `${label(e)}: PlayerController works best with a CharacterController component.`,
                );
              if (!e.tags.includes('Player'))
                warnings.push(
                  `${label(e)}: tag the player entity 'Player' (FollowCamera, Collectible and Goal look for it).`,
                );
            }
            if (
              (n === 'Collectible' || n === 'Goal' || n === 'Hazard') &&
              !e.components.some((x) => x.type === 'Collider' && x.isTrigger)
            )
              warnings.push(`${label(e)}: ${n} needs a Collider with isTrigger: true.`);
          } else if (!files.has(s)) errors.push(`${label(e)}: script file '${s}' does not exist.`);
        }
        if (c.type === 'UIText' && c.id) {
          const prev = uiIds.get(c.id as string);
          if (prev) warnings.push(`UIText id '${c.id}' is used by ${prev} and ${label(e)}.`);
          uiIds.set(c.id as string, label(e));
        }
      }
      const movable = types.includes('RigidBody') || types.includes('CharacterController');
      if (movable && e.transform.position[1] < scene.settings.killY)
        warnings.push(
          `${label(e)} starts below the kill height (${scene.settings.killY}) and will be respawned/destroyed immediately.`,
        );
    }
    if (!hasPlayerController && scene.entities.some((e) => e.tags.includes('Player')))
      warnings.push("An entity is tagged 'Player' but has no PlayerController or custom movement script.");
    if (input.buildModels) {
      for (const [key, { params, who }] of modelsToBuild) {
        const path = key.split('|')[0]!;
        try {
          const built = await h.assets.build(path, params);
          for (const issue of built.info.issues) warnings.push(`${path} (${who}): ${issue}`);
        } catch (err) {
          errors.push(`${path} (${who}) fails to build: ${(err as Error).message}`);
        }
      }
    }
    return { ok: errors.length === 0, entities: scene.entities.length, errors, warnings };
  },
});

export const apiDocs = defineCommand({
  name: 'api_docs',
  group: 'docs',
  kind: 'query',
  tier: 'core',
  description: `Read AIGE documentation. Topics: ${DOC_TOPICS.join(', ')}. Use 'modeling' before writing model recipes and 'scripting' before writing scripts. Example: {"topic":"scripting"}`,
  input: z.object({ topic: z.enum(DOC_TOPICS).default('overview'), search: z.string().optional() }).strict(),
  async run(ctx, input) {
    let text: string;
    switch (input.topic) {
      case 'overview':
        text = OVERVIEW;
        break;
      case 'conventions':
        text = CONVENTIONS;
        break;
      case 'components':
        text = componentsDoc();
        break;
      case 'modeling':
        text = MODELING;
        break;
      case 'scripting':
        text = SCRIPTING;
        break;
      case 'templates': {
        const list = await listTemplates();
        text = `# Model templates\nUse model_from_template. Parameters show defaults.\n\n${list
          .map((t) => `- ${t.name}: ${t.description}\n  params: ${paramSummary(t.params)}`)
          .join('\n')}\n`;
        break;
      }
      case 'tools':
        text = toolsDoc(toolDefinitions((ctx.services as HostServices).bus.list()));
        break;
    }
    if (input.search) {
      const q = input.search.toLowerCase();
      const lines = text.split('\n').filter((l) => l.toLowerCase().includes(q));
      text = lines.length ? lines.join('\n') : `No lines matching '${input.search}' in ${input.topic}.`;
    }
    return { topic: input.topic, text };
  },
});

export const hostCommands = [
  projectInfo,
  fileList,
  fileRead,
  fileWrite,
  fileDelete,
  modelTemplates,
  modelFromTemplate,
  modelCreate,
  modelInfo,
  modelPreview,
  modelExportGlb,
  textureGenerate,
  renderScreenshot,
  sceneValidate,
  apiDocs,
  ...scriptingCommands,
  gameRunHeadless,
  exportWebCommand,
  ...voiceCommands,
  ...assetCommands,
  ...godotCommands,
  ...characterCommands,
];
