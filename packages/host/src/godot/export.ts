import { createHash } from 'node:crypto';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComponentData, Entity, MaterialDoc } from '@aige/core';
import {
  assemblyName,
  csproj,
  exportPresets,
  type ModelRef,
  materialTres,
  projectGodot,
  RUNTIME_DIR,
  sceneToTscn,
} from '@aige/godot';
import { importGlb, type Model, toMeshData } from '@aige/modeling';
import { AMBIENCE_KINDS, renderAmbienceLoop, STORY_SFX, synthStorySfx } from '@aige/runtime';
import { getBounds, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureTransform } from '@gltf-transform/extensions';
import type { ProjectHost } from '../host.ts';
import { encodeOgg } from '../voice/audio.ts';
import { applyMaterialOverrides } from './bake.ts';
import { type CsDiagnostic, dotnetBuild, godotImport, godotInstalled } from './runner.ts';

export interface GodotExportOptions {
  /** Scene to start with (name or path); default: the project's start scene. */
  main?: string;
  /** Run `dotnet build` after writing (default true). */
  build?: boolean;
  /** Run Godot's asset import after writing (default true). */
  import?: boolean;
}

export interface GodotExportResult {
  project: string;
  mainScene: string;
  scenes: { scene: string; tscn: string; nodes: number }[];
  models: number;
  modelsBaked: number;
  materials: number;
  audio: number;
  warnings: string[];
  build?: { ok: boolean; errors: CsDiagnostic[]; warnings: CsDiagnostic[]; log: string };
  import?: { ok: boolean; log: string };
}

const sceneBase = (path: string) =>
  path
    .split('/')
    .pop()!
    .replace(/\.scene\.json$/, '');
const shortHash = (s: string | Uint8Array) => createHash('sha1').update(s).digest('hex').slice(0, 10);

/** 16-bit PCM mono WAV. */
function wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const s = (o: number, t: string) => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i));
  };
  s(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  s(8, 'WAVE');
  s(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  s(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++)
    v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), true);
  return new Uint8Array(buf);
}

/**
 * Exports the AIGE project as a Godot 4 .NET project in the same folder (see packages/godot/README.md):
 * project.godot, the C# project, addons/aige (runtime), baked GLBs with PBR materials, materials,
 * baked ambience/SFX audio and one .tscn per scene.
 */
export async function exportGodot(
  host: ProjectHost,
  opts: GodotExportOptions = {},
): Promise<GodotExportResult> {
  const state = host.state;
  const fs = host.fs;
  const warnings: string[] = [];
  const title =
    state.project.window.title || state.project.description.split(/[-–:.]/)[0]!.trim() || state.project.name;
  const assembly = assemblyName(title);

  // 1. The C# runtime
  const runtimeSrc = fileURLToPath(RUNTIME_DIR);
  const addonDir = fs.abs('addons/aige');
  await rm(addonDir, { recursive: true, force: true });
  try {
    await cp(runtimeSrc, addonDir, {
      recursive: true,
      filter: (src) => !/[\\/](bin|obj|\.godot)([\\/]|$)/.test(src) && !src.endsWith('API.md'),
    });
  } catch {
    warnings.push('AIGE C# runtime not found (packages/godot/runtime); addons/aige is missing.');
  }
  // GDScript tools that work even when the game's C# does not compile (screenshots)
  await cp(fileURLToPath(new URL('../tools/', RUNTIME_DIR)), fs.abs('addons/aige/Tools'), {
    recursive: true,
  });

  // 2. Models: every (model, params, material overrides) used by a scene
  const modelRefs = new Map<string, ModelRef | null>();
  let baked = 0;
  const materialDoc = (path: string): MaterialDoc | null => {
    const doc = state.materials[path];
    if (!doc) warnings.push(`Material '${path}' not found.`);
    return doc ?? null;
  };
  const modelFor = async (mr: ComponentData, needTris: boolean): Promise<ModelRef | null> => {
    const path = mr.model as string;
    const params = (mr.params as Record<string, unknown>) ?? {};
    const all = mr.material ? materialDoc(mr.material as string) : null;
    const parts: Record<string, MaterialDoc> = {};
    for (const [part, p] of Object.entries((mr.materials as Record<string, string>) ?? {})) {
      const d = materialDoc(p);
      if (d) parts[part] = d;
    }
    const key = JSON.stringify([path, params, all, parts, needTris]);
    if (modelRefs.has(key)) return modelRefs.get(key)!;
    let ref: ModelRef | null = null;
    // Imported .glb files (scanned models, characters) ship as they are, with their own PBR textures.
    if (path.endsWith('.glb') && !all && !Object.keys(parts).length) {
      try {
        const bytes = await fs.readBinary(path);
        if (!bytes) throw new Error('file not found');
        const out = `godot/models/${path
          .split('/')
          .pop()!
          .replace(/\.glb$/, '')}-${shortHash(bytes)}.glb`;
        if (!(await fs.exists(out))) {
          await fs.write(out, bytes);
          baked++;
        }
        const doc = await new WebIO().registerExtensions(ALL_EXTENSIONS).readBinary(bytes);
        const sceneDef = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
        const b = sceneDef ? getBounds(sceneDef) : { min: [0, 0, 0], max: [1, 1, 1] };
        ref = {
          res: `res://${out}`,
          bounds: { min: b.min as [number, number, number], max: b.max as [number, number, number] },
          collider: null,
        };
      } catch (err) {
        warnings.push(`Model '${path}': ${(err as Error).message.split('\n')[0]}`);
      }
      modelRefs.set(key, ref);
      return ref;
    }
    try {
      const built = await host.assets.build(path, params);
      let glb = built.glb;
      if (all || Object.keys(parts).length) {
        const r = await applyMaterialOverrides(
          glb,
          { ...(all ? { all } : {}), parts },
          (p) => fs.readBinary(p),
          {
            embedTextures: false,
          },
        );
        glb = r.glb;
        warnings.push(...r.warnings);
      }
      const name = path
        .split('/')
        .pop()!
        .replace(/\.(model\.ts|glb)$/, '');
      const out = `godot/models/${name}-${shortHash(key)}.glb`;
      const prev = await fs.readBinary(out);
      if (!prev || shortHash(prev) !== shortHash(glb)) {
        await fs.write(out, glb);
        baked++;
      }
      const b = built.info.bounds;
      ref = {
        res: `res://${out}`,
        bounds: { min: b.min as [number, number, number], max: b.max as [number, number, number] },
        collider: (built.info.collider as ModelRef['collider']) ?? null,
        ...(needTris ? { triangles: triangleSoup(built.model ?? (await importGlb(built.glb))) } : {}),
        ...(await glbParts(glb)),
      };
      // The scene assigns the shared .tres materials to the overridden parts (textures imported once).
      const surfaces = await glbSurfaces(glb);
      const pm: NonNullable<ModelRef['partMaterials']> = [];
      for (const [part, count] of surfaces) {
        const docPath =
          (mr.materials as Record<string, string> | undefined)?.[part] ?? (mr.material as string | undefined);
        if (docPath && state.materials[docPath])
          pm.push({
            part: (surfaces.skinned.has(part) ? 'Skeleton3D/' : '') + godotPartName(part, surfaces.root),
            surfaces: count,
            material: materialResPath(docPath),
          });
      }
      if (pm.length) {
        ref.partMaterials = pm;
        ref.root ??= surfaces.root;
      }
    } catch (err) {
      warnings.push(`Model '${path}': ${(err as Error).message.split('\n')[0]}`);
    }
    modelRefs.set(key, ref);
    return ref;
  };
  const refsByEntity = new Map<Entity, ModelRef | null>();
  for (const scene of Object.values(state.scenes))
    for (const e of scene.entities) {
      const mr = e.components.find((c) => c.type === 'MeshRenderer');
      const needTris = e.components.some(
        (c) => c.type === 'Collider' && (c.shape === 'mesh' || c.shape === 'convex'),
      );
      if (mr?.model) refsByEntity.set(e, await modelFor(mr, needTris));
    }

  // 3. Materials (shared by model parts and primitives)
  const materialRes = new Map<string, string>();
  for (const [path, doc] of Object.entries(state.materials)) {
    await writeIfChanged(host, materialResPath(path).replace('res://', ''), materialTres(doc));
    materialRes.set(path, materialResPath(path));
  }

  // 4. Audio: ambience loops used by scenes, and every story SFX (the runtime's Sfx.Play uses them)
  let audio = 0;
  const bakeAudio = async (out: string, render: () => Float32Array) => {
    if (await fs.exists(out)) return;
    const tmp = `.aige/godot/${out.split('/').pop()!.replace('.ogg', '.wav')}`;
    await fs.write(tmp, wav(render(), 44100));
    await mkdir(dirname(fs.abs(out)), { recursive: true });
    if (!(await encodeOgg(fs.abs(tmp), fs.abs(out), 'none'))) {
      await fs.write(out.replace(/\.ogg$/, '.wav'), (await fs.readBinary(tmp))!);
      warnings.push(`ffmpeg not found; ${out} was written as WAV.`);
    }
    await fs.remove(tmp);
    audio++;
  };
  const ambienceUsed = new Set<string>();
  for (const scene of Object.values(state.scenes))
    for (const e of scene.entities)
      for (const c of e.components)
        if (c.type === 'AudioSource' && c.ambience) ambienceUsed.add(c.ambience as string);
  for (const kind of AMBIENCE_KINDS)
    if (ambienceUsed.has(kind))
      await bakeAudio(`godot/audio/ambience/${kind}.ogg`, () => renderAmbienceLoop(kind, 44100, 7, 12));
  for (const preset of STORY_SFX)
    await bakeAudio(`godot/audio/sfx/${preset}.ogg`, () => synthStorySfx(preset, 44100, 1));
  const audioFor = (a: ComponentData): string | null => {
    if (a.clip) return `res://${a.clip as string}`;
    if (a.ambience) return `res://godot/audio/ambience/${a.ambience as string}.ogg`;
    if (a.sfx) return `res://godot/audio/sfx/${a.sfx as string}.ogg`;
    return null;
  };

  // 5. Scenes
  const scriptBases = new Map<string, string | null>();
  for (const scene of Object.values(state.scenes))
    for (const e of scene.entities)
      for (const c of e.components) {
        const src = c.type === 'Script' ? String(c.script) : '';
        if (!src.endsWith('.cs') || scriptBases.has(src)) continue;
        const code = await fs.read(src);
        const cls = src.split('/').pop()!.replace(/\.cs$/, '');
        const m = code && new RegExp(`class\\s+${cls}\\s*:\\s*(?:Godot\\.)?(\\w+)`).exec(code);
        scriptBases.set(src, m ? m[1]! : null);
      }
  const scenes: GodotExportResult['scenes'] = [];
  for (const [path, scene] of Object.entries(state.scenes)) {
    const r = sceneToTscn(scene, {
      model: (e) => refsByEntity.get(e) ?? null,
      material: (p) => materialRes.get(p) ?? null,
      scriptBase: (p) => scriptBases.get(p) ?? null,
      audio: audioFor,
    });
    const out = `godot/scenes/${sceneBase(path)}.tscn`;
    await writeIfChanged(host, out, r.tscn);
    for (const env of r.environments) await writeIfChanged(host, env.path, env.tres);
    scenes.push({ scene: path, tscn: out, nodes: r.nodes });
    warnings.push(...r.warnings.map((w) => `${sceneBase(path)}: ${w}`));
  }

  // 6. Project files
  const mainPath =
    Object.keys(state.scenes).find((p) => opts.main && (p === opts.main || sceneBase(p) === opts.main)) ??
    state.project.startScene;
  const mainScene = `res://godot/scenes/${sceneBase(mainPath)}.tscn`;
  await writeIfChanged(
    host,
    'project.godot',
    projectGodot({ title, assembly, mainScene, width: 1920, height: 1080 }),
  );
  if (!(await fs.exists(`${assembly}.csproj`))) await fs.write(`${assembly}.csproj`, csproj(assembly));
  if (!(await fs.exists('export_presets.cfg'))) await fs.write('export_presets.cfg', exportPresets(assembly));
  // Folders Godot must not import: voice references, and a sibling Unity project (unity_export)
  for (const dir of ['voices', 'unity'])
    if (!(await fs.exists(`${dir}/.gdignore`)) && (await fs.exists(dir)))
      await fs.write(`${dir}/.gdignore`, '');
  const gi = (await fs.read('.gitignore')) ?? '';
  const need = ['.godot/', 'dist/', 'godot/'].filter((l) => !gi.split(/\r?\n/).includes(l));
  if (need.length) await fs.write('.gitignore', `${gi.trimEnd()}\n${need.join('\n')}\n`);

  const result: GodotExportResult = {
    project: fs.abs('project.godot'),
    mainScene,
    scenes,
    models: modelRefs.size,
    modelsBaked: baked,
    materials: materialRes.size,
    audio,
    warnings: [...new Set(warnings)],
  };
  if (opts.build !== false) result.build = await dotnetBuild(host.root);
  if (opts.import !== false) {
    if (godotInstalled()) result.import = await godotImport(host.root);
    else result.warnings.push("Godot isn't installed; run `aige godot setup`.");
  }
  return result;
}

async function writeIfChanged(host: ProjectHost, path: string, content: string): Promise<void> {
  if ((await host.fs.read(path)) !== content) await host.fs.write(path, content);
}

/** Model-space triangle soup for trimesh/convex colliders (capped at 30k triangles). */
function triangleSoup(model: Model): () => number[] {
  const data = toMeshData(model);
  const out: number[] = [];
  for (const part of data.parts)
    for (const p of part.primitives)
      for (let i = 0; i < p.indices.length && out.length < 90_000 * 3; i++) {
        const v = p.indices[i]! * 3;
        out.push(p.positions[v]!, p.positions[v + 1]!, p.positions[v + 2]!);
      }
  return () => out;
}

/** The GLB's root node name and the parts whose materials are transparent. */
async function glbParts(glb: Uint8Array): Promise<{ root?: string; noShadowParts?: string[] }> {
  const doc = await new WebIO().registerExtensions([KHRTextureTransform]).readBinary(glb);
  const root =
    doc.getRoot().getDefaultScene()?.listChildren()[0] ?? doc.getRoot().listScenes()[0]?.listChildren()[0];
  if (!root) return {};
  const parts = root
    .listChildren()
    .filter((n) =>
      n
        .getMesh()
        ?.listPrimitives()
        .some((p) => p.getMaterial()?.getAlphaMode() === 'BLEND'),
    )
    .map((n) => godotPartPath(n, root.getName()));
  return parts.length ? { root: root.getName(), noShadowParts: parts } : {};
}

/** res:// path of the shared Godot material written for a 'materials/<name>.material.json' doc. */
function materialResPath(docPath: string): string {
  const name = docPath
    .split('/')
    .pop()!
    .replace(/\.material\.json$/, '');
  return `res://godot/materials/${name}.tres`;
}

/** Surface (primitive) count per part node, and the GLB's root node name. */
async function glbSurfaces(
  glb: Uint8Array,
): Promise<Map<string, number> & { root?: string; skinned: Set<string> }> {
  const doc = await new WebIO().registerExtensions([KHRTextureTransform]).readBinary(glb);
  const root = (doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0])?.listChildren()[0];
  const out = Object.assign(new Map<string, number>(), { skinned: new Set<string>() }) as Map<
    string,
    number
  > & {
    root?: string;
    skinned: Set<string>;
  };
  if (!root) return out;
  out.root = root.getName();
  for (const n of root.listChildren()) {
    const mesh = n.getMesh();
    if (mesh) out.set(n.getName(), mesh.listPrimitives().length);
    if (mesh && n.getSkin()) out.skinned.add(n.getName());
  }
  return out;
}

/** A part's node path under the GLB root after import: skinned meshes live under the imported Skeleton3D. */
function godotPartPath(n: { getName(): string; getSkin(): unknown }, root: string): string {
  return (n.getSkin() ? 'Skeleton3D/' : '') + godotPartName(n.getName(), root);
}

/** The node name Godot gives a part after import (names are made unique across the file: 'slab' in 'slab' → 'slab2'). */
function godotPartName(part: string, root: string | undefined): string {
  return part === root ? `${part}2` : part;
}
