import {
  AigeError,
  createSceneDoc,
  type Entity,
  getScene,
  type ImageRef,
  type ProjectState,
  resolveEntity,
  type SceneDoc,
} from '@aige/core';
import { toBase64 } from '@aige/modeling';
import type { SnapshotRequest, SnapshotResult, ViewSpec } from '@aige/render';
import type { AssetPipeline, ModelInfo } from '../assets.ts';
import type { ProjectFs } from '../fs.ts';
import { PlaywrightBackend, type RenderBackend } from './playwright.ts';

export interface ScreenshotOptions {
  scene?: string;
  /** Override the scene document (e.g. a running game's snapshot). */
  sceneDoc?: SceneDoc;
  views?: ViewSpec[];
  width?: number;
  height?: number;
  labels?: boolean;
  grid?: boolean;
  focus?: string[];
  name?: string;
  save?: boolean;
}

export interface RenderContext {
  fs: ProjectFs;
  assets: AssetPipeline;
  state(): ProjectState;
}

/** Turns project state into render requests and saves the results as screenshots. */
export class RenderService {
  private backend: RenderBackend | null;
  private readonly ctx: RenderContext;

  constructor(ctx: RenderContext, backend?: RenderBackend | null) {
    this.ctx = ctx;
    this.backend = backend === undefined ? new PlaywrightBackend() : backend;
  }

  setBackend(backend: RenderBackend | null): void {
    this.backend = backend;
  }

  get backendName(): string {
    return this.backend?.name ?? 'none';
  }

  private need(): RenderBackend {
    if (!this.backend) {
      throw new AigeError('UNSUPPORTED', 'Rendering is disabled in this session.', {
        hint: 'Start the MCP server/CLI without --no-render, or open the editor.',
      });
    }
    return this.backend;
  }

  /** Builds every model the scene uses; failures become warnings (rendered as magenta boxes). */
  async collectModels(scene: SceneDoc): Promise<{
    models: Record<string, string>;
    meshKeys: Record<string, string>;
    warnings: string[];
    infos: Record<string, ModelInfo>;
  }> {
    const models: Record<string, string> = {};
    const meshKeys: Record<string, string> = {};
    const infos: Record<string, ModelInfo> = {};
    const warnings: string[] = [];
    for (const e of scene.entities) {
      const mr = e.components.find((c) => c.type === 'MeshRenderer');
      if (!mr?.model) continue;
      try {
        const built = await this.ctx.assets.build(
          mr.model as string,
          (mr.params as Record<string, unknown>) ?? {},
        );
        meshKeys[e.id] = built.info.key;
        infos[e.id] = built.info;
        if (!models[built.info.key]) models[built.info.key] = toBase64(built.glb);
      } catch (err) {
        warnings.push(`${e.id} ${e.name}: model '${mr.model}' failed to build: ${(err as Error).message}`);
      }
    }
    return { models, meshKeys, warnings, infos };
  }

  /** Texture files referenced by materials (base64 PNG by path). */
  async collectTextures(state: ProjectState): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const m of Object.values(state.materials)) {
      if (!m.map || out[m.map]) continue;
      const bytes = await this.ctx.fs.readBinary(m.map);
      if (bytes) out[m.map] = toBase64(bytes);
    }
    return out;
  }

  async screenshot(
    opts: ScreenshotOptions = {},
  ): Promise<{ image: ImageRef; result: SnapshotResult; warnings: string[] }> {
    const state = this.ctx.state();
    const scene = opts.sceneDoc ?? getScene(state, opts.scene);
    const hasCamera = scene.entities.some((e) => e.active && e.components.some((c) => c.type === 'Camera'));
    const views: ViewSpec[] =
      opts.views ?? (hasCamera ? [{ kind: 'camera' }, { kind: 'iso' }] : [{ kind: 'iso' }, { kind: 'top' }]);
    // Frame what matters: skip ground planes unless they are all there is.
    let focus = opts.focus?.map((ref) => resolveEntity(scene, ref).id);
    if (!focus) {
      // skip grounds, seas and other huge backdrop planes
      const interesting = scene.entities.filter(
        (e) =>
          e.active &&
          e.components.some((c) => c.type === 'MeshRenderer') &&
          !e.tags.some((t) => t === 'Ground' || t === 'Background') &&
          e.name !== 'Ground' &&
          Math.max(...e.transform.scale.map(Math.abs)) < 30,
      );
      if (interesting.length) focus = interesting.map((e) => e.id);
    }
    const { models, meshKeys, warnings } = await this.collectModels(scene);
    const textures = await this.collectTextures(state);
    const width = opts.width ?? (views.length > 1 ? 1280 : 1024);
    const height = opts.height ?? (views.length === 2 ? 640 : views.length > 2 ? 1024 : 768);
    const req: SnapshotRequest = {
      width,
      height,
      views,
      scene,
      project: { render: state.project.render },
      materials: state.materials,
      models,
      meshKeys,
      textures,
      overlays: { labels: opts.labels ?? true, grid: opts.grid ?? false },
      ...(focus?.length ? { focus } : {}),
      title: scene.name,
    };
    const result = await this.need().snapshot(req);
    const image = await this.saveImage(
      result,
      opts.name ?? scene.name,
      opts.save ?? true,
      'scene screenshot',
    );
    return { image, result, warnings };
  }

  /** Multi-view studio preview of a single model (iso / front / right / top by default). */
  async modelPreview(
    path: string,
    params: Record<string, unknown> = {},
    opts: { views?: ViewSpec[]; size?: number; save?: boolean } = {},
  ): Promise<{ image: ImageRef; info: ModelInfo; result: SnapshotResult }> {
    const built = await this.ctx.assets.build(path, params);
    const scene = createSceneDoc('preview');
    const entity: Entity = {
      id: 'e1',
      name: path.split('/').pop()!.replace(/\..*$/, ''),
      parent: null,
      active: true,
      tags: [],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [
        { type: 'MeshRenderer', model: path, castShadow: true, receiveShadow: true, visible: true },
      ],
    };
    scene.entities.push(entity);
    const size = opts.size ?? 1024;
    const views = opts.views ?? [{ kind: 'iso' }, { kind: 'front' }, { kind: 'right' }, { kind: 'top' }];
    const result = await this.need().snapshot({
      width: size,
      height: views.length === 2 ? Math.round(size / 2) : size,
      views,
      scene,
      models: { [built.info.key]: toBase64(built.glb) },
      meshKeys: { e1: built.info.key },
      overlays: { grid: true, dimensions: true },
      studio: true,
      title: entity.name,
    });
    const image = await this.saveImage(
      result,
      `model-${entity.name}`,
      opts.save ?? true,
      `preview of ${path}`,
    );
    return { image, info: built.info, result };
  }

  private async saveImage(
    result: SnapshotResult,
    name: string,
    save: boolean,
    label: string,
  ): Promise<ImageRef> {
    const image: ImageRef = {
      mimeType: 'image/png',
      data: result.png,
      label,
      width: result.width,
      height: result.height,
    };
    if (save) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const path = `.aige/screenshots/${stamp}-${name.replace(/[^\w-]+/g, '_')}.png`;
      await this.ctx.fs.write(path, Buffer.from(result.png, 'base64'));
      image.path = path;
    }
    return image;
  }

  async gpuInfo() {
    return this.backend ? this.backend.info() : null;
  }

  async close(): Promise<void> {
    await this.backend?.close();
  }
}
