import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ComponentData, canonicalJson, type Entity, type MaterialDoc } from '@aige/core';
import { AMBIENCE_KINDS, renderAmbienceLoop, STORY_SFX, synthStorySfx } from '@aige/runtime';
import {
  manifestJson,
  metaFile,
  packageVersions,
  parentFolders,
  patchProjectSettings,
  portGodotScript,
  sceneToUnity,
  type TextureRole,
  UNITY_GITIGNORE,
  UNITY_PACKAGES,
  UNITY_RUNTIME_DIR,
  type UnityModelRef,
} from '@aige/unity';
import { getBounds, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { applyMaterialOverrides } from '../godot/bake.ts';
import type { ProjectHost } from '../host.ts';
import { encodeOgg } from '../voice/audio.ts';
import {
  type CsError,
  editorPackageManifest,
  logTail,
  parseCompileErrors,
  projectLocked,
  runUnity,
  unityEditor,
} from './editor.ts';

/** The Unity project lives in `<game>/unity/`. */
export const UNITY_DIR = 'unity';

export interface UnityExportOptions {
  /** Scene to start with (name or path); default: the project's start scene. */
  main?: string;
  /** Run Unity in batch mode to import assets, compile C# and build the scenes (default true). */
  import?: boolean;
}

export interface UnityExportResult {
  project: string;
  mainScene: string;
  scenes: { scene: string; data: string; unity: string }[];
  models: number;
  modelsWritten: number;
  materials: number;
  textures: number;
  audio: number;
  scriptsPorted: string[];
  warnings: string[];
  unity?: {
    ok: boolean;
    editor: string;
    seconds: number;
    compileErrors: CsError[];
    scenes: { name: string; path: string; objects: number }[];
    importWarnings: string[];
    errors: string[];
    log: string;
  };
}

const sceneBase = (path: string) =>
  path
    .split('/')
    .pop()!
    .replace(/\.scene\.json$/, '');
const shortHash = (s: string | Uint8Array) => createHash('sha1').update(s).digest('hex').slice(0, 10);
const baseName = (p: string) =>
  p
    .split('/')
    .pop()!
    .replace(/\.(model\.ts|glb|gltf|material\.json)$/, '');

/** A 1×1 PNG: overridden parts keep texture slots in the GLB (so glTFast generates tangents); the importer swaps in shared URP materials. */
const PLACEHOLDER_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

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

async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else out.push(p);
  }
  return out;
}

/**
 * Exports the AIGE project as a Unity 6 (URP) project in `<game>/unity/` (see packages/unity/README.md):
 * packages, the AIGE C# runtime + importer (Assets/Aige), baked models, textures, MaterialDocs, audio,
 * cutscenes and voice lines (Assets/Resources/aige), scene data (Assets/AigeData/scenes), then runs the
 * Unity importer in batch mode, which compiles the C# and builds Assets/Scenes/<scene>.unity.
 */
export async function exportUnity(
  host: ProjectHost,
  opts: UnityExportOptions = {},
): Promise<UnityExportResult> {
  const state = host.state;
  const fs = host.fs;
  const warnings: string[] = [];
  const U = (p: string) => `${UNITY_DIR}/${p}`;
  const title =
    state.project.window.title || state.project.description.split(/[-–:.]/)[0]!.trim() || state.project.name;
  const editor = unityEditor();

  const writeIfChanged = async (path: string, content: string | Uint8Array): Promise<boolean> => {
    const prev = typeof content === 'string' ? await fs.read(path) : await fs.readBinary(path);
    const same =
      prev !== null &&
      (typeof content === 'string' ? prev === content : shortHash(prev as Uint8Array) === shortHash(content));
    if (!same) await fs.write(path, content);
    return !same;
  };
  /** Writes deterministic .meta files for an asset and its folders (only when missing). */
  const metas = async (assetPath: string) => {
    for (const folder of parentFolders(assetPath))
      if (!(await fs.exists(U(`${folder}.meta`))))
        await fs.write(U(`${folder}.meta`), metaFile(folder, true));
    if (!(await fs.exists(U(`${assetPath}.meta`))))
      await fs.write(U(`${assetPath}.meta`), metaFile(assetPath));
  };
  const asset = async (assetPath: string, content: string | Uint8Array) => {
    const changed = await writeIfChanged(U(assetPath), content);
    await metas(assetPath);
    return changed;
  };

  // 1. Project files
  if (!(await fs.exists(U('.gdignore')))) await fs.write(U('.gdignore'), '');
  if (!(await fs.exists(U('.gitignore')))) await fs.write(U('.gitignore'), UNITY_GITIGNORE);
  const versions = packageVersions(editor ? editorPackageManifest(editor.exe) : null);
  let extra: Record<string, string> = {};
  try {
    const prev = JSON.parse((await fs.read(U('Packages/manifest.json'))) ?? '{}') as {
      dependencies?: Record<string, string>;
    };
    extra = Object.fromEntries(
      Object.entries(prev.dependencies ?? {}).filter(([k]) => !(k in UNITY_PACKAGES)),
    );
  } catch {
    /* new project */
  }
  await writeIfChanged(U('Packages/manifest.json'), manifestJson(versions, extra));
  const settings = await fs.read(U('ProjectSettings/ProjectSettings.asset'));
  if (settings)
    await writeIfChanged(U('ProjectSettings/ProjectSettings.asset'), patchProjectSettings(settings, title));

  // 2. The C# runtime and importer (Assets/Aige), stable GUIDs so references survive re-exports
  const runtimeSrc = fileURLToPath(UNITY_RUNTIME_DIR);
  const shipped = new Set<string>();
  for (const file of await listFiles(runtimeSrc)) {
    const rel = relative(runtimeSrc, file).replaceAll('\\', '/');
    if (/(^|\/)(bin|obj)\//.test(rel)) continue;
    const assetPath = `Assets/Aige/${rel}`;
    shipped.add(assetPath);
    await asset(assetPath, new Uint8Array(await readFile(file)));
  }
  for (const file of await listFiles(fs.abs(U('Assets/Aige')))) {
    const rel = relative(fs.abs(UNITY_DIR), file).replaceAll('\\', '/');
    const assetPath = rel.replace(/\.meta$/, '');
    if (shipped.has(assetPath) || (rel.endsWith('.meta') && existsSync(fs.abs(U(assetPath))))) continue;
    await rm(file, { force: true });
  }

  // 3. Textures and MaterialDocs (shared URP materials are built by the importer)
  const roles = new Map<string, TextureRole>();
  const texturePath = (p: string) => `Assets/AigeData/${p.replace(/^\.?\//, '')}`;
  const copyTexture = async (p: string, role: TextureRole): Promise<string | null> => {
    const bytes = await fs.readBinary(p);
    if (!bytes) {
      warnings.push(`Texture '${p}' not found.`);
      return null;
    }
    const out = texturePath(p);
    await asset(out, bytes);
    if (role !== 'color' || !roles.has(out)) roles.set(out, role);
    return out;
  };
  const materialPath = new Map<string, string>();
  for (const [path, doc] of Object.entries(state.materials)) {
    const md: Record<string, unknown> = { ...doc };
    for (const [key, role] of [
      ['map', 'color'],
      ['normalMap', 'normal'],
      ['ormMap', 'linear'],
      ['heightMap', 'linear'],
    ] as const) {
      const t = doc[key];
      if (typeof t === 'string') {
        const out = await copyTexture(t, role);
        if (out) md[key] = out;
        else delete md[key];
      }
    }
    const out = `Assets/AigeData/materials/${baseName(path)}.json`;
    await asset(out, canonicalJson(md));
    materialPath.set(path, out);
  }

  // 4. Models: every (model, params, material overrides) used by a scene
  const modelRefs = new Map<string, UnityModelRef | null>();
  let written = 0;
  const materialDoc = (path: string): MaterialDoc | null => {
    const doc = state.materials[path];
    if (!doc) warnings.push(`Material '${path}' not found.`);
    return doc ?? null;
  };
  const modelFor = async (mr: ComponentData): Promise<UnityModelRef | null> => {
    const path = mr.model as string;
    const params = (mr.params as Record<string, unknown>) ?? {};
    const all = mr.material ? materialDoc(mr.material as string) : null;
    const parts: Record<string, MaterialDoc> = {};
    for (const [part, p] of Object.entries((mr.materials as Record<string, string>) ?? {})) {
      const d = materialDoc(p);
      if (d) parts[part] = d;
    }
    const overrides = !!all || Object.keys(parts).length > 0;
    const key = JSON.stringify([path, params, mr.material ?? null, mr.materials ?? null]);
    if (modelRefs.has(key)) return modelRefs.get(key)!;
    let ref: UnityModelRef | null = null;
    try {
      let glb: Uint8Array;
      let bounds: { min: number[]; max: number[] } | null = null;
      let collider: UnityModelRef['collider'] = null;
      if (path.endsWith('.glb')) {
        const bytes = await fs.readBinary(path);
        if (!bytes) throw new Error('file not found');
        glb = bytes;
        const doc = await new WebIO().registerExtensions(ALL_EXTENSIONS).readBinary(bytes);
        const sceneDef = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
        if (sceneDef) bounds = getBounds(sceneDef);
      } else {
        const built = await host.assets.build(path, params);
        glb = built.glb;
        bounds = built.info.bounds;
        collider = (built.info.collider as UnityModelRef['collider']) ?? null;
      }
      if (overrides) {
        const r = await applyMaterialOverrides(
          glb,
          { ...(all ? { all } : {}), parts },
          async () => PLACEHOLDER_PNG,
          {
            embedTextures: true,
          },
        );
        glb = r.glb;
      }
      const out = `Assets/AigeData/models/${baseName(path)}-${shortHash(key)}.glb`;
      if (await asset(out, glb)) written++;
      ref = {
        asset: out,
        ...(bounds
          ? {
              bounds: {
                min: bounds.min as [number, number, number],
                max: bounds.max as [number, number, number],
              },
            }
          : {}),
        collider,
      };
    } catch (err) {
      warnings.push(`Model '${path}': ${(err as Error).message.split('\n')[0]}`);
    }
    modelRefs.set(key, ref);
    return ref;
  };
  const refsByEntity = new Map<Entity, UnityModelRef | null>();
  for (const scene of Object.values(state.scenes))
    for (const e of scene.entities) {
      const mr = e.components.find((c) => c.type === 'MeshRenderer');
      if (mr?.model) refsByEntity.set(e, await modelFor(mr));
    }

  // 5. Audio, cutscenes and voice lines (Assets/Resources/aige mirrors the AIGE paths)
  let audio = 0;
  for (const dir of ['audio', 'cutscenes']) {
    for (const file of await listFiles(fs.abs(dir))) {
      const rel = relative(fs.abs(''), file).replaceAll('\\', '/');
      if (!/\.(json|ogg|wav|mp3)$/i.test(rel)) continue;
      await asset(`Assets/Resources/aige/${rel}`, new Uint8Array(await readFile(file)));
      if (!rel.endsWith('.json')) audio++;
    }
  }
  const baked = new Map<string, string>();
  const bakeAudio = async (name: string, render: () => Float32Array) => {
    const ogg = `Assets/Resources/aige/${name}.ogg`;
    const wavPath = `Assets/Resources/aige/${name}.wav`;
    if ((await fs.exists(U(ogg))) || (await fs.exists(U(wavPath)))) {
      baked.set(name, (await fs.exists(U(ogg))) ? ogg : wavPath);
      return;
    }
    const tmp = `.aige/unity/${name.replaceAll('/', '_')}.wav`;
    await fs.write(tmp, wav(render(), 44100));
    await mkdir(dirname(fs.abs(U(ogg))), { recursive: true });
    if (await encodeOgg(fs.abs(tmp), fs.abs(U(ogg)), 'none')) baked.set(name, ogg);
    else {
      await fs.write(U(wavPath), (await fs.readBinary(tmp))!);
      baked.set(name, wavPath);
      warnings.push(`ffmpeg not found; ${wavPath} was written as WAV.`);
    }
    await metas(baked.get(name)!);
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
      await bakeAudio(`ambience/${kind}`, () => renderAmbienceLoop(kind, 44100, 7, 12));
  for (const preset of STORY_SFX) await bakeAudio(`sfx/${preset}`, () => synthStorySfx(preset, 44100, 1));
  const audioFor = (a: ComponentData): string | null => {
    if (a.clip) return `Assets/Resources/aige/${String(a.clip).replace(/^\.?\//, '')}`;
    if (a.ambience) return baked.get(`ambience/${a.ambience as string}`) ?? null;
    if (a.sfx) return baked.get(`sfx/${a.sfx as string}`) ?? null;
    return null;
  };

  // 6. Game scripts: Unity ports live in Assets/Scripts (a first-pass port of the Godot script is written once)
  const scriptsPorted: string[] = [];
  const scriptFor = new Map<string, { name: string; path: string } | null>();
  for (const scene of Object.values(state.scenes))
    for (const e of scene.entities)
      for (const c of e.components) {
        const src = c.type === 'Script' ? String(c.script) : '';
        if (!src.endsWith('.cs') || scriptFor.has(src)) continue;
        const name = src.split('/').pop()!.replace(/\.cs$/, '');
        const out = `Assets/Scripts/${name}.cs`;
        if (!(await fs.exists(U(out)))) {
          const code = await fs.read(src);
          if (code) {
            const port = portGodotScript(code, name);
            await asset(out, port.code);
            scriptsPorted.push(out);
            warnings.push(
              `${out}: first-pass port of ${src}; review it${port.notes.length ? ` (${port.notes.join('; ')})` : ''}.`,
            );
          }
        }
        scriptFor.set(src, (await fs.exists(U(out))) ? { name, path: out } : null);
      }

  // 7. Scenes
  const scenes: UnityExportResult['scenes'] = [];
  for (const [path, scene] of Object.entries(state.scenes)) {
    const r = sceneToUnity(scene, {
      model: (e) => refsByEntity.get(e) ?? null,
      material: (p) => materialPath.get(p) ?? null,
      audio: audioFor,
      texture: (p) => texturePath(p),
      script: (p) => scriptFor.get(p) ?? null,
    });
    for (const e of r.doc.entities) {
      const hdri = e.environment?.hdri;
      if (typeof hdri === 'string') {
        const src = hdri.replace(/^Assets\/AigeData\//, '');
        if (!(await copyTexture(src, 'hdri'))) delete e.environment!.hdri;
      }
    }
    const out = `Assets/AigeData/scenes/${sceneBase(path)}.json`;
    await asset(out, canonicalJson(r.doc));
    scenes.push({ scene: path, data: out, unity: `Assets/Scenes/${sceneBase(path)}.unity` });
    warnings.push(...r.warnings.map((w) => `${sceneBase(path)}: ${w}`));
  }
  await asset('Assets/AigeData/textures.json', canonicalJson(Object.fromEntries([...roles].sort())));
  const mainPath =
    Object.keys(state.scenes).find((p) => opts.main && (p === opts.main || sceneBase(p) === opts.main)) ??
    state.project.startScene;
  await asset(
    'Assets/AigeData/project.json',
    canonicalJson({
      title,
      mainScene: sceneBase(mainPath),
      scenes: scenes.map((s) => sceneBase(s.scene)),
      width: 1920,
      height: 1080,
    }),
  );

  const result: UnityExportResult = {
    project: fs.abs(UNITY_DIR),
    mainScene: `Assets/Scenes/${sceneBase(mainPath)}.unity`,
    scenes,
    models: modelRefs.size,
    modelsWritten: written,
    materials: materialPath.size,
    textures: roles.size,
    audio,
    scriptsPorted,
    warnings: [...new Set(warnings)],
  };
  if (opts.import === false) return result;
  if (!editor) {
    result.warnings.push(
      'Unity is not installed (install Unity 6 with Unity Hub, or set AIGE_UNITY to Unity.exe).',
    );
    return result;
  }
  result.unity = await importProject(host, editor);
  return result;
}

/** Runs AigeImporter.ImportAll in batch mode and collects compile errors, scene results and warnings. */
export async function importProject(
  host: ProjectHost,
  editor: { exe: string; version: string },
): Promise<NonNullable<UnityExportResult['unity']>> {
  const dir = host.fs.abs(UNITY_DIR);
  const empty = { editor: editor.version, seconds: 0, compileErrors: [], scenes: [], importWarnings: [] };
  if (await projectLocked(dir))
    return {
      ...empty,
      ok: false,
      errors: ['The Unity project is open in the Unity editor.'],
      log: 'Close the editor and run unity_export again, or use the menu AIGE > Import All in the open editor (unity_export with import:false writes the data first).',
    };
  const reportFile = join(dir, 'Logs', 'aige-import.json');
  await mkdir(dirname(reportFile), { recursive: true });
  await rm(reportFile, { force: true });
  const started = Date.now();
  const run = await runUnity(
    editor.exe,
    dir,
    ['-executeMethod', 'Aige.Editor.AigeImporter.ImportAll', '-aigeReport', reportFile],
    {
      logFile: join(dir, 'Logs', 'aige-import.log'),
    },
  );
  const compileErrors = parseCompileErrors(run.log);
  let report: {
    ok?: boolean;
    scenes?: { name: string; path: string; objects: number }[];
    warnings?: string[];
    errors?: string[];
  } = {};
  try {
    report = JSON.parse(await readFile(reportFile, 'utf8'));
  } catch {
    /* the importer did not run (compile errors or a crash) */
  }
  const errors = [...(report.errors ?? [])];
  if (run.timedOut) errors.push('Unity timed out.');
  if (!existsSync(reportFile) && !compileErrors.length)
    errors.push(`The importer did not run (exit code ${run.code}).`);
  const ok = !run.timedOut && compileErrors.length === 0 && report.ok === true;
  return {
    ok,
    editor: editor.version,
    seconds: Math.round((Date.now() - started) / 1000),
    compileErrors,
    scenes: report.scenes ?? [],
    importWarnings: report.warnings ?? [],
    errors,
    log: ok ? '' : logTail(run.log),
  };
}

/** Size and age of the last import (for `aige unity status`). */
export async function unityStatus(host: ProjectHost) {
  const dir = host.fs.abs(UNITY_DIR);
  const editor = unityEditor();
  const scenes = existsSync(join(dir, 'Assets', 'Scenes'))
    ? (await readdir(join(dir, 'Assets', 'Scenes'))).filter((f) => f.endsWith('.unity'))
    : [];
  let lastImport: string | null = null;
  try {
    lastImport = (await stat(join(dir, 'Logs', 'aige-import.json'))).mtime.toISOString();
  } catch {
    /* never imported */
  }
  return {
    editor: editor ? { version: editor.version, exe: editor.exe } : null,
    project: dir,
    exported: existsSync(join(dir, 'Assets', 'AigeData', 'project.json')),
    scenes,
    lastImport,
    open: await projectLocked(dir),
  };
}
