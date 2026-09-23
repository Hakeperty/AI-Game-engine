/**
 * @aige/godot: exports AIGE games to Godot 4 .NET projects. Game code is C#; the AIGE C# runtime
 * lives in ../runtime and is copied into each game as addons/aige. See ../README.md for the contract.
 */
export {
  AUTOLOADS,
  assemblyName,
  csproj,
  exportPresets,
  GODOT_FEATURES,
  GODOT_VERSION,
  INPUT_ACTIONS,
  materialTres,
  type ProjectGodotOptions,
  projectGodot,
} from './project.ts';
export {
  BUILTIN_SCRIPTS,
  COMPONENT_SCRIPTS,
  environmentTres,
  type ModelRef,
  propValue,
  type SceneExportContext,
  type SceneExportResult,
  sceneToTscn,
} from './scene.ts';
export * from './tscn.ts';

/** Absolute path of the C# runtime sources (copied to addons/aige on export). */
export const RUNTIME_DIR = new URL('../runtime/', import.meta.url);
