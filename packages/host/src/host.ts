import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  AigeError,
  type AnyCommand,
  type BusEvent,
  type CommandBus,
  type CommandSource,
  compactJson,
  createCoreBus,
  type ProjectState,
  type ToolDefinition,
  type ToolResult,
  toErrorInfo,
  toolDefinitions,
} from '@aige/core';
import type { Patch } from 'immer';
import { AssetPipeline } from './assets.ts';
import { type HostServices, hostCommands } from './commands.ts';
import { ProjectFs } from './fs.ts';
import {
  createProjectFiles,
  isProject,
  loadProject,
  writeDoc,
  writeProjectSupportFiles,
  writeWorkspace,
} from './project-io.ts';
import type { RenderBackend } from './render/playwright.ts';
import { RenderService } from './render/service.ts';

export interface HostOptions {
  /** Render backend: default headless Chromium; null disables rendering. */
  render?: RenderBackend | null;
  /** Extra commands to register (runtime, scripting, export, editor...). */
  commands?: AnyCommand[];
}

type DocKind = 'project' | 'scenes' | 'materials' | 'prefabs';

/** Extra command providers registered by other packages (runtime/scripting, export). */
const extraCommandProviders: (() => AnyCommand[])[] = [];
export function registerHostCommands(provider: () => AnyCommand[]): void {
  extraCommandProviders.push(provider);
}

/**
 * The authority for one open project: owns the command bus, files, asset pipeline and renderer.
 * Every client (MCP, editor, in-editor agent, CLI) talks to a ProjectHost.
 */
export class ProjectHost {
  readonly root: string;
  readonly fs: ProjectFs;
  readonly bus: CommandBus<HostServices>;
  readonly assets: AssetPipeline;
  readonly render: RenderService;
  private dirty = new Set<string>();
  private workspaceDirty = false;
  private saving: Promise<void> = Promise.resolve();
  private logQueue: Promise<void> = Promise.resolve();

  private constructor(root: string, state: ProjectState, opts: HostOptions) {
    this.root = resolve(root);
    this.fs = new ProjectFs(this.root);
    this.assets = new AssetPipeline(this.fs);
    const services = { host: this } as unknown as HostServices;
    this.bus = createCoreBus(state, this.fs, services) as unknown as CommandBus<HostServices>;
    this.bus.register(...hostCommands);
    for (const provider of extraCommandProviders) this.bus.register(...provider());
    if (opts.commands) this.bus.register(...opts.commands);
    this.render = new RenderService(
      { fs: this.fs, assets: this.assets, state: () => this.bus.state },
      opts.render,
    );
    this.bus.on((e) => this.onBusEvent(e));
    this.bus.onLog((entry) => {
      const line = `${compactJson({ ...entry, t: new Date().toISOString() })}\n`;
      this.logQueue = this.logQueue.then(() => appendLog(this.fs, line)).catch(() => undefined);
    });
  }

  static async open(root: string, opts: HostOptions = {}): Promise<ProjectHost> {
    const fs = new ProjectFs(root);
    const state = await loadProject(fs);
    const host = new ProjectHost(root, state, opts);
    // keep generated support files (tsconfig paths) pointing at this engine checkout
    await writeProjectSupportFiles(fs);
    return host;
  }

  static async create(
    root: string,
    init: { name: string; template?: 'empty' | 'basic'; description?: string },
    opts: HostOptions = {},
  ): Promise<ProjectHost> {
    const fs = new ProjectFs(root);
    const state = await createProjectFiles(fs, init);
    return new ProjectHost(root, state, opts);
  }

  get state(): ProjectState {
    return this.bus.state;
  }

  /** Calls a tool; never throws. */
  call<O = unknown>(
    name: string,
    input: unknown = {},
    source: CommandSource = 'internal',
  ): Promise<ToolResult<O>> {
    return this.bus.call<O>(name, input, { source });
  }

  tools(): ToolDefinition[] {
    return toolDefinitions(this.bus.list());
  }

  private onBusEvent(e: BusEvent): void {
    if (e.type === 'state') {
      for (const p of e.patches) this.markDirty(p);
    } else if (e.type === 'reset') {
      this.dirty.add('project');
      for (const k of Object.keys(e.state.scenes)) this.dirty.add(`scenes|${k}`);
      for (const k of Object.keys(e.state.materials)) this.dirty.add(`materials|${k}`);
      for (const k of Object.keys(e.state.prefabs)) this.dirty.add(`prefabs|${k}`);
    } else if (e.type === 'command') {
      if (this.dirty.size || this.workspaceDirty)
        this.saving = this.saving.then(() => this.save()).catch(() => undefined);
    }
  }

  private markDirty(p: Patch): void {
    const [root, key] = p.path as (string | number)[];
    if (root === 'project') this.dirty.add('project');
    else if (root === 'activeScene') this.workspaceDirty = true;
    else if ((root === 'scenes' || root === 'materials' || root === 'prefabs') && typeof key === 'string')
      this.dirty.add(`${root}|${key}`);
  }

  /** Writes changed documents to disk (called automatically after every command). */
  async save(): Promise<void> {
    // Snapshot the dirty set and the state together; anything that changes while we write is
    // flagged again and handled by the next loop iteration.
    while (this.dirty.size || this.workspaceDirty) {
      const items = [...this.dirty];
      this.dirty.clear();
      const workspace = this.workspaceDirty;
      this.workspaceDirty = false;
      const state = this.bus.state;
      for (const item of items) {
        const [kind, key] = item.split('|') as [DocKind, string | undefined];
        await writeDoc(this.fs, state, kind, key);
      }
      if (workspace) await writeWorkspace(this.fs, state);
    }
  }

  /** Resolves when all pending saves and log writes are on disk. */
  async flush(): Promise<void> {
    await this.saving;
    await this.logQueue;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.render.close();
  }
}

async function appendLog(fs: ProjectFs, line: string): Promise<void> {
  const { appendFile, mkdir } = await import('node:fs/promises');
  const path = fs.abs('.aige/logs/commands.jsonl');
  await mkdir(join(path, '..'), { recursive: true });
  await appendFile(path, line);
}

// ---------------------------------------------------------------------------------------------
// Workspace: routes tools to the currently open project (MCP servers start without one)
// ---------------------------------------------------------------------------------------------

export const DEFAULT_WORKSPACE_DIR = join(homedir(), 'AigeProjects');

export interface WorkspaceOptions extends HostOptions {
  /** Where project_create puts new projects when no absolute path is given. */
  workspaceDir?: string;
}

const WORKSPACE_TOOLS: ToolDefinition[] = [
  {
    name: 'project_create',
    group: 'project',
    kind: 'mutation',
    tier: 'core',
    description:
      'Create a new AIGE game project and open it. template "basic" gives a camera, a sun and a ground plane. `path` defaults to <workspace>/<name>. Example: {"name":"coin-quest","description":"3D platformer where you collect coins"}',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name (letters, digits, -)' },
        path: { type: 'string', description: 'Folder (absolute, or relative to the workspace folder)' },
        template: { type: 'string', enum: ['basic', 'empty'], default: 'basic' },
        description: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_open',
    group: 'project',
    kind: 'mutation',
    tier: 'core',
    description:
      'Open an existing AIGE project folder (one containing project.json). Example: {"path":"coin-quest"}',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder (absolute, or relative to the workspace folder)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_list',
    group: 'project',
    kind: 'query',
    tier: 'extended',
    description: 'List AIGE projects in the workspace folder.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** Holds zero or one open ProjectHost and exposes a stable tool list. */
export class Workspace {
  current: ProjectHost | null = null;
  readonly dir: string;
  private readonly opts: WorkspaceOptions;
  private template: ProjectHost | null = null;
  private readonly listeners = new Set<(host: ProjectHost | null) => void>();

  constructor(opts: WorkspaceOptions = {}) {
    this.opts = opts;
    this.dir = resolve(opts.workspaceDir ?? DEFAULT_WORKSPACE_DIR);
  }

  onChange(fn: (host: ProjectHost | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private resolvePath(p: string): string {
    return isAbsolute(p) ? p : resolve(this.dir, p);
  }

  async open(path: string): Promise<ProjectHost> {
    const root = this.resolvePath(path);
    if (!(await isProject(new ProjectFs(root)))) {
      throw new AigeError('NOT_FOUND', `No AIGE project at '${root}'.`, {
        hint: 'Use project_create, or project_list to see existing projects.',
      });
    }
    await this.current?.close();
    this.current = await ProjectHost.open(root, this.opts);
    for (const l of this.listeners) l(this.current);
    return this.current;
  }

  async create(
    name: string,
    path?: string,
    template?: 'basic' | 'empty',
    description?: string,
  ): Promise<ProjectHost> {
    if (!/^[\w-]+$/.test(name))
      throw new AigeError('INVALID_INPUT', 'Project name may only contain letters, digits, _ and -.');
    const root = this.resolvePath(path ?? name);
    await this.current?.close();
    this.current = await ProjectHost.create(
      root,
      { name, ...(template ? { template } : {}), ...(description ? { description } : {}) },
      this.opts,
    );
    for (const l of this.listeners) l(this.current);
    return this.current;
  }

  /** Tool definitions (workspace tools + every project tool, available even before a project is open). */
  async tools(): Promise<ToolDefinition[]> {
    const project = this.current ?? (await this.templateHost());
    return [...WORKSPACE_TOOLS, ...project.tools()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A throwaway in-memory host used only to enumerate tool definitions before a project is open. */
  private async templateHost(): Promise<ProjectHost> {
    if (this.template) return this.template;
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'aige-tools-'));
    this.template = await ProjectHost.create(
      dir,
      { name: 'tools', template: 'empty' },
      { ...this.opts, render: null },
    );
    return this.template;
  }

  async call(name: string, input: unknown, source: CommandSource = 'mcp'): Promise<ToolResult> {
    try {
      if (name === 'project_create') {
        const i = (input ?? {}) as {
          name?: string;
          path?: string;
          template?: 'basic' | 'empty';
          description?: string;
        };
        if (!i.name) throw new AigeError('INVALID_INPUT', "project_create needs a 'name'.");
        const host = await this.create(i.name, i.path, i.template, i.description);
        return {
          ok: true,
          result: {
            root: host.root,
            scene: host.state.activeScene,
            next: 'Use scene_tree to see the starter scene.',
          },
        };
      }
      if (name === 'project_open') {
        const i = (input ?? {}) as { path?: string };
        if (!i.path) throw new AigeError('INVALID_INPUT', "project_open needs a 'path'.");
        const host = await this.open(i.path);
        return {
          ok: true,
          result: { root: host.root, name: host.state.project.name, scenes: Object.keys(host.state.scenes) },
        };
      }
      if (name === 'project_list') {
        const { readdir } = await import('node:fs/promises');
        let entries: string[] = [];
        try {
          entries = (await readdir(this.dir, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        } catch {
          // workspace folder does not exist yet
        }
        const projects: string[] = [];
        for (const e of entries) if (await isProject(new ProjectFs(join(this.dir, e)))) projects.push(e);
        return { ok: true, result: { workspace: this.dir, projects, open: this.current?.root ?? null } };
      }
      if (!this.current) {
        throw new AigeError('INVALID_STATE', 'No project is open.', {
          hint: 'Call project_create (new game) or project_open first.',
        });
      }
      return await this.current.call(name, input, source);
    } catch (err) {
      return { ok: false, error: toErrorInfo(err) };
    }
  }

  async close(): Promise<void> {
    await this.current?.close();
    await this.template?.close();
    this.current = null;
  }
}
