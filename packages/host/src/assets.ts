import { createHash } from 'node:crypto';
import { AigeError, canonicalJson, compactJson } from '@aige/core';
import * as modeling from '@aige/modeling';
import {
  type ColliderHint,
  describeParams,
  exportGlb,
  importGlb,
  initModeling,
  isRecipe,
  KERNEL_VERSION,
  type Model,
  type ModelReport,
  type ParamDef,
  readGlbSkeleton,
  type Socket,
  validateModel,
} from '@aige/modeling';
import type { ProjectFs } from './fs.ts';
import { compileUserModule, runInModuleContext, runModule } from './sandbox.ts';

export interface ModelInfo {
  path: string;
  key: string;
  params: Record<string, unknown>;
  paramDefs: Record<string, ParamDef>;
  bounds: { min: number[]; max: number[]; size: number[]; center: number[] };
  triangles: number;
  parts: string[];
  sockets: Record<string, Socket>;
  collider: ColliderHint | null;
  issues: string[];
  logs: string[];
  buildMs: number;
}

export interface BuiltModel {
  info: ModelInfo;
  glb: Uint8Array;
  /** Only present when freshly built this session (not when loaded from the disk cache). */
  model?: Model;
}

const hash = (s: string | Uint8Array) => createHash('sha1').update(s).digest('hex').slice(0, 16);

const MODEL_GLOBAL = '__aigeModel';

/**
 * Builds model assets (recipes or .glb files) with memory + disk caching.
 * Recipes are bundled with esbuild and executed in a sandboxed V8 context.
 */
export class AssetPipeline {
  private readonly fs: ProjectFs;
  private readonly memory = new Map<string, BuiltModel>();
  private ready: Promise<void> | null = null;

  constructor(fs: ProjectFs) {
    this.fs = fs;
  }

  private init(): Promise<void> {
    this.ready ??= initModeling();
    return this.ready;
  }

  /** Cache key for a model + params (compiles the recipe to hash its full source). */
  async modelKey(path: string, params: Record<string, unknown> = {}): Promise<string> {
    return (await this.prepare(path, params)).key;
  }

  private async prepare(path: string, params: Record<string, unknown>) {
    const norm = path.replaceAll('\\', '/');
    if (norm.endsWith('.glb')) {
      const bytes = await this.fs.readBinary(norm);
      if (!bytes) throw this.notFound(norm);
      return { kind: 'glb' as const, path: norm, key: `g${hash(bytes)}`, bytes };
    }
    if (!/\.model\.(ts|js)$/.test(norm)) {
      throw new AigeError(
        'INVALID_INPUT',
        `'${path}' is not a model. Models are 'models/<name>.model.ts' recipes or '.glb' files.`,
      );
    }
    if (!(await this.fs.exists(norm))) throw this.notFound(norm);
    const compiled = await compileUserModule({
      entry: this.fs.abs(norm),
      root: this.fs.root,
      virtuals: { 'aige/model': MODEL_GLOBAL },
    });
    const key = `m${hash(`${compiled.code}\n${compactJson(params)}\n${KERNEL_VERSION}`)}`;
    return { kind: 'recipe' as const, path: norm, key, compiled };
  }

  private notFound(path: string): AigeError {
    return new AigeError('NOT_FOUND', `Model file '${path}' not found.`, {
      hint: 'Create it with model_create or model_from_template, or check the path with file_list.',
    });
  }

  /** Builds (or loads from cache) a model with the given parameter overrides. */
  async build(
    path: string,
    params: Record<string, unknown> = {},
    opts: { keepModel?: boolean } = {},
  ): Promise<BuiltModel> {
    const prep = await this.prepare(path, params);
    const cached = this.memory.get(prep.key);
    if (cached && (!opts.keepModel || cached.model)) return cached;
    if (!opts.keepModel) {
      const disk = await this.readDiskCache(prep.key);
      if (disk) {
        this.remember(prep.key, disk);
        return disk;
      }
    }
    await this.init();
    const started = Date.now();
    let model: Model;
    let logs: string[] = [];
    let paramDefs: Record<string, ParamDef> = {};
    if (prep.kind === 'glb') {
      model = await importGlb(prep.bytes);
    } else {
      const {
        exports,
        logs: l,
        context,
      } = runModule(prep.compiled, {
        filename: prep.path,
        globals: { [MODEL_GLOBAL]: modeling },
      });
      logs = l;
      const recipe = exports.default ?? exports;
      if (!isRecipe(recipe)) {
        throw new AigeError('INVALID_INPUT', `${prep.path} must \`export default defineModel({...})\`.`, {
          hint: "import { defineModel, p, box } from 'aige/model'; export default defineModel({ params: {}, build: () => box() });",
        });
      }
      paramDefs = describeParams(recipe);
      (context as Record<string, unknown>).__recipe = recipe;
      (context as Record<string, unknown>).__params = params;
      try {
        model = runInModuleContext<Model>(
          context,
          `globalThis.${MODEL_GLOBAL}.buildRecipe(globalThis.__recipe, globalThis.__params)`,
          prep.compiled,
          prep.path,
          Number(process.env.AIGE_BUILD_TIMEOUT_MS) || 20_000,
        );
      } catch (err) {
        if (
          err instanceof AigeError &&
          err.code === 'SCRIPT_ERROR' &&
          /Unknown parameter|must be/.test(err.message)
        ) {
          throw new AigeError('INVALID_INPUT', err.message, {
            hint: `Parameters: ${Object.entries(paramDefs)
              .map(([k, d]) => `${k} (${d.type}, default ${JSON.stringify(d.default)})`)
              .join(', ')}`,
          });
        }
        throw err;
      }
    }
    const report: ModelReport = validateModel(model);
    // skinned .glb files (characters) ship as they are: importGlb keeps the geometry only, not skins or clips
    const glb =
      prep.kind === 'glb' && (await readGlbSkeleton(prep.bytes))
        ? prep.bytes
        : await exportGlb(model, { name: prep.path.split('/').pop()!.replace(/\..*$/, '') });
    const b = model.bounds();
    const info: ModelInfo = {
      path: prep.path,
      key: prep.key,
      params,
      paramDefs,
      bounds: { min: b.min, max: b.max, size: b.size, center: b.center },
      triangles: report.triangles,
      parts: model.parts.map((p) => p.name),
      sockets: model.sockets,
      collider: model.collider,
      issues: report.issues,
      logs,
      buildMs: Date.now() - started,
    };
    const built: BuiltModel = { info, glb, model };
    this.remember(prep.key, built);
    await this.writeDiskCache(prep.key, built);
    return built;
  }

  private remember(key: string, built: BuiltModel): void {
    this.memory.delete(key);
    this.memory.set(key, built);
    while (this.memory.size > 300) this.memory.delete(this.memory.keys().next().value!);
  }

  private async readDiskCache(key: string): Promise<BuiltModel | null> {
    const glb = await this.fs.readBinary(`.aige/cache/models/${key}.glb`);
    const json = await this.fs.read(`.aige/cache/models/${key}.json`);
    if (!glb || !json) return null;
    try {
      return { glb, info: JSON.parse(json) as ModelInfo };
    } catch {
      return null;
    }
  }

  private async writeDiskCache(key: string, built: BuiltModel): Promise<void> {
    await this.fs.write(`.aige/cache/models/${key}.glb`, built.glb);
    await this.fs.write(`.aige/cache/models/${key}.json`, canonicalJson(built.info));
  }
}
