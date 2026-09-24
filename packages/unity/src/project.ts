import { createHash } from 'node:crypto';
import { canonicalJson } from '@aige/core';

/** Packages the exported project needs, with the versions Unity 6.5 bundles (used when the editor can't be read). */
export const UNITY_PACKAGES: Record<string, string> = {
  'com.unity.cloud.gltfast': '6.14.1',
  'com.unity.inputsystem': '1.20.0',
  'com.unity.render-pipelines.universal': '17.5.0',
  'com.unity.ugui': '2.5.0',
};

/** Built-in modules the runtime uses. */
export const UNITY_MODULES = [
  'animation',
  'audio',
  'director',
  'imageconversion',
  'imgui',
  'jsonserialize',
  'particlesystem',
  'physics',
  'screencapture',
  'ui',
  'uielements',
  'unitywebrequest',
  'unitywebrequestaudio',
  'unitywebrequesttexture',
];

/**
 * Package versions to use, taken from the editor's own package manifest
 * (`<Editor>/Data/Resources/PackageManager/Editor/manifest.json`) so they match the installed Unity.
 */
export function packageVersions(editorManifest: unknown): Record<string, string> {
  const out = { ...UNITY_PACKAGES };
  const pkgs = (
    editorManifest as { packages?: Record<string, { version?: string; minimumVersion?: string }> }
  )?.packages;
  if (!pkgs) return out;
  for (const name of Object.keys(out)) {
    const p = pkgs[name];
    const v = p?.version ?? p?.minimumVersion;
    if (v) out[name] = v;
  }
  return out;
}

/** Packages/manifest.json. Packages the game added itself (`extra`) are kept. */
export function manifestJson(versions: Record<string, string>, extra: Record<string, string> = {}): string {
  const deps: Record<string, string> = { ...extra, ...versions };
  for (const m of UNITY_MODULES) deps[`com.unity.modules.${m}`] = '1.0.0';
  return canonicalJson({ dependencies: deps });
}

/** .gitignore for the Unity project folder (caches and generated models are rebuilt by `unity_export`). */
export const UNITY_GITIGNORE = [
  '/Library/',
  '/Temp/',
  '/Logs/',
  '/obj/',
  '/UserSettings/',
  '/Build/',
  '/Builds/',
  '/Build*/',
  '/MemoryCaptures/',
  '/Assets/AigeData/models/',
  '/Assets/AigeData/models.meta',
  '*.csproj',
  '*.sln',
  '*.slnx',
  '',
].join('\n');

/**
 * Patches ProjectSettings.asset (when Unity has created it): linear color space and both input
 * backends (the runtime supports either; 'Both' keeps game scripts that use the old Input class working).
 */
export function patchProjectSettings(text: string, productName?: string): string {
  let out = text
    .replace(/(\n\s*m_ActiveColorSpace:) \d+/, '$1 1')
    .replace(/(\n\s*activeInputHandler:) \d+/, '$1 2');
  if (productName) out = out.replace(/(\n\s*productName:) .*/, `$1 ${productName.replace(/[\r\n]/g, ' ')}`);
  return out;
}

/** Deterministic Unity GUID for a project path, so re-exports and other machines keep the same references. */
export function unityGuid(projectPath: string): string {
  return createHash('md5')
    .update(`aige:${projectPath.replaceAll('\\', '/')}`)
    .digest('hex');
}

/** A minimal .meta file: Unity fills in the importer defaults and keeps the GUID. */
export function metaFile(projectPath: string, folder = false): string {
  return `fileFormatVersion: 2\nguid: ${unityGuid(projectPath)}\n${folder ? 'folderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n' : ''}`;
}

/** Folder names from a project path, e.g. 'Assets/A/B/x.cs' → ['Assets/A', 'Assets/A/B']. */
export function parentFolders(projectPath: string): string[] {
  const parts = projectPath.split('/');
  const out: string[] = [];
  for (let i = 2; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

/** Texture roles for the importer's texture postprocessor (normal maps and linear data maps). */
export type TextureRole = 'color' | 'normal' | 'linear' | 'hdri';

/**
 * First-pass port of a Godot C# game script (written against the AIGE Godot runtime) to Unity. The
 * AIGE APIs (Story, Hud, Voice, Sfx, Cutscenes, Entities, Log) have the same names in both runtimes, so
 * only the engine glue changes. The result is written once to Assets/Scripts and never overwritten;
 * review it (anything engine-specific beyond these rules is listed in `notes`).
 */
export function portGodotScript(code: string, className: string): { code: string; notes: string[] } {
  const notes: string[] = [];
  let c = code.replace(/\r\n/g, '\n');
  c = c.replace(/^using Godot;\s*$/m, 'using UnityEngine;');
  if (!/^using UnityEngine;/m.test(c)) c = `using UnityEngine;\n${c}`;
  c = c.replace(/^namespace\s+([\w.]+)\s*;\s*$/m, (_, ns) => {
    notes.push(`file-scoped namespace '${ns}' removed (Unity uses C# 9)`);
    return '';
  });
  c = c.replace(
    new RegExp(`public\\s+(?:partial\\s+)?class\\s+${className}\\s*:\\s*(?:Godot\\.)?\\w+`),
    `public class ${className} : MonoBehaviour`,
  );
  c = c.replace(/\[Export(?:\([^)]*\))?\]\s*/g, '');
  c = c.replace(/public\s+override\s+void\s+_Ready\s*\(\s*\)/g, 'void Start()');
  c = c.replace(/public\s+override\s+void\s+_EnterTree\s*\(\s*\)/g, 'void Awake()');
  c = c.replace(/public\s+override\s+void\s+_ExitTree\s*\(\s*\)/g, 'void OnDestroy()');
  c = c.replace(
    /public\s+override\s+void\s+_Process\s*\(\s*double\s+(\w+)\s*\)\s*\{/g,
    'void Update()\n    {\n        double $1 = Time.deltaTime;',
  );
  c = c.replace(
    /public\s+override\s+void\s+_PhysicsProcess\s*\(\s*double\s+(\w+)\s*\)\s*\{/g,
    'void FixedUpdate()\n    {\n        double $1 = Time.fixedDeltaTime;',
  );
  c = c.replace(/CallDeferred\(\s*MethodName\.(\w+)\s*\)/g, 'Invoke(nameof($1), 0f)');
  c = c.replace(/\bGD\.Print(?:Rich)?\(/g, 'Debug.Log(');
  c = c.replace(/\bGD\.PushWarning\(/g, 'Debug.LogWarning(');
  c = c.replace(/\bGD\.PushError\(/g, 'Debug.LogError(');
  c = c.replace(/\bAnimator\.Of\(/g, 'AigeAnimator.Of(');
  c = c.replace(/\bNode3D\?/g, 'GameObject?').replace(/\bNode3D\b/g, 'GameObject');
  c = c.replace(/\bGlobalPosition\b/g, 'transform.position');
  for (const [pattern, what] of [
    [/\bGetNode(?:OrNull)?</, 'GetNode<T>() (use Entities.Find or GetComponent)'],
    [/\bGetTree\(\)/, 'GetTree() (use Unity APIs)'],
    [/\bInput\.IsAction/, 'Godot Input actions (use AigeInput.Pressed("interact"))'],
    [/\bToSignal\(/, 'await ToSignal (use coroutines)'],
    [/\bVector3\.(?:Forward|Back)\b/, 'Vector3.Forward/Back (Unity: forward is +Z)'],
  ] as const)
    if (pattern.test(c)) notes.push(`uses ${what}`);
  const header = `// Unity port of scripts/${className}.cs, generated by AIGE unity_export (first pass; edit freely,\n// it is never overwritten). The AIGE C# API is in Assets/Aige/API.md.\n`;
  return { code: header + c.replace(/\n{3,}/g, '\n\n'), notes };
}
