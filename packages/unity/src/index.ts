/**
 * @aige/unity: exports AIGE games to Unity 6 (URP) projects. Game code is C#; the AIGE C# runtime and
 * the scene importer live in ../runtime and are copied into each project as Assets/Aige. See ../README.md.
 */
export * from './coords.ts';
export {
  manifestJson,
  metaFile,
  packageVersions,
  parentFolders,
  patchProjectSettings,
  portGodotScript,
  type TextureRole,
  UNITY_GITIGNORE,
  UNITY_MODULES,
  UNITY_PACKAGES,
  unityGuid,
} from './project.ts';
export * from './scene.ts';

/** Absolute URL of the C# sources (Runtime/ and Editor/, copied to Assets/Aige on export). */
export const UNITY_RUNTIME_DIR = new URL('../runtime/', import.meta.url);
