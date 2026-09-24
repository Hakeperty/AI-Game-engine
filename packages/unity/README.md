# @aige/unity: Unity 6 (URP) export

AIGE authors games (scenes, procedural models, voices, cutscenes, story logic). **Unity 6 runs them** with the Universal Render Pipeline. Game code is **C#** (MonoBehaviours). The same AIGE project can also be exported to Godot (`@aige/godot`); the two C# runtimes share one API shape.

This package has two halves that meet at the contract below:
- `src/` (TypeScript): coordinate conversion, scene mapping (AIGE scene → importer scene data), project files, and a first-pass port of Godot game scripts. The host (`packages/host/src/unity/`) bakes assets, writes the project and drives Unity in batch mode.
- `runtime/` (C#): copied into every project as `Assets/Aige/`. `Runtime/` is the AIGE runtime for Unity (namespace `Aige`, assembly `Aige.Runtime`); `Editor/` is the importer that builds `.unity` scenes (assembly `Aige.Editor`). API: `runtime/API.md`.

Target: **Unity 6000.x** (tested with 6000.5), URP 17, glTFast 6 (versions are read from the installed editor). The editor is found through Unity Hub (newest installed) or `AIGE_UNITY` (path to `Unity.exe`).

## Tools

| Tool / CLI | What it does |
|---|---|
| `unity_export` / `aige unity export -p <game>` | Writes the project and data, then runs `Aige.Editor.AigeImporter.ImportAll` in batch mode. Returns C# compile errors as file:line, the built scenes and importer warnings. `import: false` only writes the data. |
| `unity_screenshot` | Renders fixed views (AIGE coordinates) of a built scene with `Aige.Editor.AigeShots.Capture` (batch mode with graphics) and returns PNGs. |
| `unity_play_test` | Plays the scene in the editor's Play mode in batch mode (`Aige.Editor.AigePlay.Run`, fixed 60 fps) with scripted inputs/teleports, and returns the AigeTest report (story events, probes, final state, errors) plus screenshots at `captureAt`. |
| `unity_open` / `aige unity open` | Opens the project in the Unity editor. |
| `unity_status` / `aige unity status` | Installed editor, exported scenes, last import, whether the editor holds the project. |

Batch mode needs the project closed in the editor. With the editor open, run `unity_export` with `import: false` and use the menu **AIGE › Import All**.

## Project layout: `<game>/unity/`

```
unity/
  Packages/manifest.json        URP, glTFast, Input System, uGUI (+ packages the game added, kept)
  ProjectSettings/              created by Unity; export sets linear color, both input backends, product name
  Assets/Aige/                  runtime + importer (overwritten on export; stable GUIDs: do not edit)
  Assets/Scripts/*.cs           game scripts (yours; a Godot scripts/X.cs is ported once, never overwritten)
  Assets/AigeData/              generated data
    scenes/<scene>.json           importer scene data (Unity coordinates)
    materials/<name>.json         MaterialDocs (texture paths remapped); the importer writes <name>.mat (URP Lit)
    models/<name>-<hash>.glb      baked models (glTFast import; git-ignored)
    textures/**                   textures and HDRIs, shared by all materials (imported once)
    environments/                 VolumeProfiles and skybox materials (importer)
    Settings/                     URP asset + renderer with SSAO (importer)
    textures.json, project.json   texture roles (normal / linear / hdri), title + main scene
  Assets/Resources/aige/        runtime data with AIGE paths: cutscenes/*.cutscene.json, audio/voice/*.json|.ogg,
                                ambience/<kind>.ogg and sfx/<preset>.ogg (baked with AIGE's synth)
  Assets/Scenes/<scene>.unity   built by the importer (rebuilt on every import)
```
`.meta` files the exporter writes use GUIDs derived from the asset path, so references stay valid across re-exports and machines. `.gdignore` keeps Godot out of the folder.

## Coordinates

AIGE is right-handed (three.js/glTF), Unity is left-handed; both are Y-up meters. The exporter **mirrors X**, exactly like glTFast does for GLBs, so baked models, scene transforms and runtime data agree:

| AIGE | Unity |
|---|---|
| position / direction `(x, y, z)` | `(-x, y, z)` |
| quaternion `(x, y, z, w)` | `(x, -y, -z, w)` |
| Euler degrees `[a, b, c]` (XYZ order) | `Rx(a) · Ry(-b) · Rz(-c)` |
| yaw, Door `openAngle`, Rotator speed | negated around Y |

Models face +Z in both, so `transform.forward` is where a character looks. AIGE cameras and lights look along their entity's -Z, so they sit on a child (`Camera`, `Light`) rotated 180° around Y. The rendered image is not mirrored (tests in `src/unity.test.ts`). At runtime use `Coords.Position/Rotation` for AIGE values; cutscene and test data are converted on load.

## Scene mapping (AIGE scene → .unity)

A root GameObject named after the scene holds the entities, parented as in AIGE. Each entity gets an `AigeEntity` (id + tags); tag `Player` also sets Unity's `Player` tag. Inactive entities are deactivated GameObjects (cutscenes and `Entities.SetEnabled` turn them on).

- **MeshRenderer**: child `Mesh` = an instance of the baked GLB prefab (glTFast). `material` / `materials` (per part name, like AIGE) become **shared URP Lit materials** built from the MaterialDocs: color, roughness, metalness, normal map, and the glTF ORM map repacked for URP (R metallic, G occlusion, A smoothness), `mapRepeat` as tiling. Transparent parts cast no shadows. Primitives use Unity primitives scaled to AIGE's unit sizes.
- **Collider**: box/sphere/capsule colliders on the entity; cylinder = convex mesh collider; mesh/convex = MeshColliders on the model's meshes; `auto` = the recipe's collider hint or the model bounds. Trigger colliders go on a child `Area` with `TriggerArea`, which forwards to the entity's `Trigger`.
- **CharacterController** → Unity CharacterController (height, radius, center, stepOffset, slopeLimit). **RigidBody** → Rigidbody (dynamic/kinematic; fixed = static colliders).
- **Light** → child `Light` (directional/point/spot; spot angle ×2 since Unity uses the full cone; soft shadows; `flicker` adds `LightFlicker`). Intensities use `AigeLights.Intensity` (point lights ×1.6). Ambient/hemisphere lights feed the ambient color when there is no Environment.
- **Camera** → child `Camera` with URP post-processing and SMAA; the primary one is `MainCamera` with the AudioListener.
- **AudioSource** → child `Audio` (Unity AudioSource + `AigeAudio`), clip from `Resources/aige/...`.
- **Environment** → `AigeEnvironment` on the entity with a VolumeProfile asset (tonemapping ACES/Neutral, exposure, contrast, saturation, bloom, vignette, film grain, white balance, chromatic aberration), a skybox (HDRI via Skybox/Panoramic or a procedural sky), exponential fog and ambient light. The first active one drives the root `Environment` object (global Volume + `EnvironmentFx`); SSAO strength/radius configure the URP renderer's SSAO feature. Not available in URP: volumetric fog, SDFGI/SSIL, auto exposure.
- **Gameplay components** → `Interactable`, `Door`, `Trigger`, `AigeParticles`, `AigeAnimator` on the entity, props assigned by name (`requireFlag` → `RequireFlag`). The Animator gets the model's glTF animation clips.
- **Script**: `builtin:PlayerController|ThirdPersonCamera|Rotator` → the runtime class; `scripts/X.cs` → the class in `Assets/Scripts/X.cs`. Props map to public (or `[SerializeField]`) fields case-insensitively.

## Documents read at runtime

CutsceneDoc and VoiceLineDoc (`packages/core/src/schema/documents.ts`) are loaded from `Resources/aige/` by their AIGE paths (`cutscenes/cs1.cutscene.json`, `audio/voice/<id>.json`). `res://` prefixes and Godot baked-audio paths are accepted. Cutscene `emit: "env:<Environment entity name>"` cross-fades environments (Godot `.tres` paths map to the entity name).

## Test harness

`unity_play_test` runs it inside the editor (no build needed). `AigeTest` also runs when a player build gets `-aige-test=<test.json> -aige-report=<report.json>` (or the `AIGE_TEST`/`AIGE_REPORT` environment variables). The test and report formats match the Godot harness (`packages/godot/README.md`); positions are AIGE coordinates. Game time advances at a fixed 60 fps.
