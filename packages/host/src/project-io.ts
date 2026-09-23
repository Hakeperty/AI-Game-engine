import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  AigeError,
  allocateEntityId,
  basicSceneEntities,
  canonicalJson,
  createProjectDoc,
  createSceneDoc,
  MaterialDoc,
  PrefabDoc,
  ProjectDoc,
  type ProjectState,
  SceneDoc,
} from '@aige/core';
import type { z } from 'zod';
import type { ProjectFs } from './fs.ts';

/** Root of the engine repository (used for type paths in generated project tsconfigs). */
export const ENGINE_ROOT = resolve(import.meta.dirname, '..', '..', '..');

function parseDoc<T extends z.ZodType>(schema: T, text: string, path: string): z.output<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new AigeError('IO_ERROR', `${path} is not valid JSON: ${(err as Error).message}`);
  }
  const res = schema.safeParse(json);
  if (!res.success) {
    throw new AigeError(
      'IO_ERROR',
      `${path} is invalid: ${res.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return res.data;
}

export async function isProject(fs: ProjectFs): Promise<boolean> {
  return fs.exists('project.json');
}

/** Reads project.json and every scene/material/prefab file into a ProjectState. */
export async function loadProject(fs: ProjectFs): Promise<ProjectState> {
  const text = await fs.read('project.json');
  if (text === null) {
    throw new AigeError('NOT_FOUND', `No project.json in ${fs.root}.`, {
      hint: 'Create a project with project_create or `aige new`.',
    });
  }
  const project = parseDoc(ProjectDoc, text, 'project.json');
  const state: ProjectState = {
    project,
    scenes: {},
    materials: {},
    prefabs: {},
    activeScene: project.startScene,
  };
  for (const path of await fs.list('', { pattern: /\.scene\.json$/ })) {
    state.scenes[path] = parseDoc(SceneDoc, (await fs.read(path))!, path);
  }
  for (const path of await fs.list('', { pattern: /\.material\.json$/ })) {
    state.materials[path] = parseDoc(MaterialDoc, (await fs.read(path))!, path);
  }
  for (const path of await fs.list('', { pattern: /\.prefab\.json$/ })) {
    state.prefabs[path] = parseDoc(PrefabDoc, (await fs.read(path))!, path);
  }
  const ws = await fs.read('.aige/workspace.json');
  if (ws) {
    try {
      const active = JSON.parse(ws).activeScene;
      if (typeof active === 'string' && state.scenes[active]) state.activeScene = active;
    } catch {
      // ignore corrupt workspace state
    }
  }
  if (!state.scenes[state.activeScene]) {
    const first = Object.keys(state.scenes)[0];
    if (first) state.activeScene = first;
    else {
      state.scenes[project.startScene] = createSceneDoc('main');
      state.activeScene = project.startScene;
    }
  }
  return state;
}

/** Writes one document of the state (by kind + key) in canonical JSON. */
export async function writeDoc(
  fs: ProjectFs,
  state: ProjectState,
  kind: 'project' | 'scenes' | 'materials' | 'prefabs',
  key?: string,
): Promise<void> {
  if (kind === 'project') {
    await fs.write('project.json', canonicalJson(state.project));
    return;
  }
  const doc = state[kind][key!];
  if (doc === undefined) await fs.remove(key!);
  else await fs.write(key!, canonicalJson(doc));
}

export async function writeWorkspace(fs: ProjectFs, state: ProjectState): Promise<void> {
  await fs.write('.aige/workspace.json', canonicalJson({ activeScene: state.activeScene }));
}

export interface CreateProjectOptions {
  name: string;
  template?: 'empty' | 'basic';
  description?: string;
}

/** Scaffolds a new project folder with a basic scene, tsconfig, and AI instructions. */
export async function createProjectFiles(fs: ProjectFs, opts: CreateProjectOptions): Promise<ProjectState> {
  if (await fs.exists('project.json')) {
    throw new AigeError('CONFLICT', `A project already exists in ${fs.root}.`, { hint: 'Open it instead.' });
  }
  const project = createProjectDoc(opts.name);
  if (opts.description) project.description = opts.description;
  const scene = createSceneDoc('main');
  if ((opts.template ?? 'basic') === 'basic') {
    for (const e of basicSceneEntities()) scene.entities.push({ ...e, id: allocateEntityId(scene) });
  }
  const state: ProjectState = {
    project,
    scenes: { [project.startScene]: scene },
    materials: {},
    prefabs: {},
    activeScene: project.startScene,
  };
  await fs.write('project.json', canonicalJson(project));
  await fs.write(project.startScene, canonicalJson(scene));
  await writeProjectSupportFiles(fs);
  return state;
}

/** (Re)writes tsconfig.json, .gitignore and CLAUDE.md for a project. Safe to call repeatedly. */
export async function writeProjectSupportFiles(fs: ProjectFs): Promise<void> {
  const rel = (p: string) => relative(fs.root, p).split('\\').join('/');
  const modelingPath = rel(join(ENGINE_ROOT, 'packages', 'modeling', 'src', 'index.ts'));
  const runtimePath = rel(join(ENGINE_ROOT, 'packages', 'runtime', 'src', 'api.ts'));
  const tsconfig = {
    compilerOptions: {
      target: 'ES2023',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2023', 'DOM'],
      types: [],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: false,
      paths: {
        'aige/model': [modelingPath],
        aige: [runtimePath],
      },
    },
    include: ['models/**/*.ts', 'scripts/**/*.ts'],
  };
  await fs.write('tsconfig.json', `${JSON.stringify(tsconfig, null, 2)}\n`);
  if (!(await fs.exists('.gitignore'))) await fs.write('.gitignore', '.aige/\ndist/\nnode_modules/\n');
  await fs.write('CLAUDE.md', PROJECT_CLAUDE_MD);
}

export function projectRootFor(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'project.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export const PROJECT_CLAUDE_MD = `# AIGE game project

This folder is an AIGE game project. Build it with the \`aige\` MCP tools, not by hand-editing JSON.

## Workflow
1. \`scene_tree\` to see what exists. \`api_docs\` for the scripting and modeling reference.
2. Make models with \`model_from_template\` (fast) or \`model_create\` (a TypeScript recipe in models/). Always look at the \`model_preview\` image and fix what looks wrong.
3. Place entities with \`entity_create\` / \`batch\`. Put models on them with a MeshRenderer that uses \`model\`.
4. Write game logic with \`script_write\` (scripts/*.ts), then attach it with a Script component.
5. Verify: \`render_screenshot\` (look at it!), \`scene_validate\`, and \`game_run_headless\` with scripted inputs.
6. \`export_web\` to produce a playable build in dist/.

## Conventions
- Y is up, units are meters, rotations are Euler degrees [x, y, z].
- The default camera sits at +Z looking toward -Z. Models face +Z.
- Scenes, materials and prefabs are canonical JSON, written by the tools. Scripts and model recipes are TypeScript.
`;
