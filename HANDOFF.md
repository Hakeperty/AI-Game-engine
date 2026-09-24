# AIGE: hand-off

This file is a snapshot of where the AIGE engine stands, written so you (or any AI agent: Claude Code, ArcFlare's agent, etc.) can pick up locally. Last updated 2026-09-24.

**Games are not in this repo.** Each game lives in its own (private) repository and is cloned into `games/<name>/`, which this repo ignores. The game's tsconfig and MCP config reach the engine through `../../packages`, so the engine tools work on it unchanged. Each game repo has its own HANDOFF.md.

---

## 1. The big picture

- **AIGE** is an AI-native "Unity + Blender in one", written in TypeScript. It does procedural modeling, scenes, voice acting, cutscene documents and MCP tools.
- **Games run on Godot 4.7 .NET, with game code in C#.** AIGE is the authoring layer and exports each game as a Godot C# project: a native exe with SDFGI global illumination, volumetric fog and so on. The older TypeScript/Three.js runtime remains for fast previews.
- **Unity 6 export** (URP) works too: `unity_export` writes a Unity project next to the game and imports it in batch mode (see `packages/unity/README.md`).

## 2. What the engine has

| Area | What | Where |
|---|---|---|
| **Voice acting** | Local **Qwen3-TTS** server (VoiceDesign plus Base voice cloning). Every take is checked with **Whisper** (transcript WER), **WavLM speaker similarity** to the character's reference voice and pitch drift, and the best take is kept. Output is Ogg plus a VoiceLineDoc with a 30 fps lip-sync mouth curve. | `tools/tts/server.py`, `packages/host/src/voice/*`, `aige tts setup/status/stop`; tools `voice_design`, `voice_line(s)`, `voice_list`, `tts_status` |
| **Image generation** | FLUX.1-schnell 4-bit on the local GPU for 2D story images (photos, paintings). About 40 s to load, then about 5 s per image. | `tools/tts/imagegen.py` |
| **Realistic assets** | Poly Haven CC0 search and download: scanned PBR textures become material docs at real-world scale; HDRIs; glTF models made game-ready (foliage cards thinned, meshes simplified to a triangle budget). Every asset is credited in the game's CREDITS.md. | `packages/host/src/assets/polyhaven.ts`; tools `asset_search`, `asset_fetch` |
| **Characters** | Realistic skinned, animated humans (humanoid skeleton, skin weights, clothing, hair, built-in story clips), glTF skin/animation export. Presets: `young_man`, `boy`, `woman`, `none`. | `packages/modeling/src/character/`, tools `character_create`, `animation_list`, `animation_preview` |
| **Materials** | MaterialDoc with `ormMap`, `normalScale`, `aoIntensity`; MeshRenderer with per-part `materials`; Decal component. | `packages/core/src/schema/*` |
| **Environment** | HDRI sky, SDFGI, SSIL, volumetric fog, auto exposure, grade, vignette, grain, chromatic aberration. | `packages/core/src/schema/environment.ts` |
| **Cutscenes / story** | CutsceneDoc (camera, animation, move, voice, sound, subtitle, fx, light, event) and VoiceLineDoc. Components: Interactable, Door, Trigger, ParticleSystem, Animator, Decal. | `packages/core/src/schema/documents.ts`, `components.ts` |
| **Godot exporter** | AIGE scene → `.tscn` (bodies, colliders incl. trimesh, lights, audio, components, decals), shared `.tres` materials, environment `.tres` (switchable at runtime), project.godot, csproj, export presets (`dist/`). Copies the C# runtime, runs `dotnet build` and a Godot import. | `packages/godot/` (contract: `packages/godot/README.md`), `packages/host/src/godot/*` |
| **Godot tools** | `godot_export`, `godot_play_test` (headless scripted play-tests with an event report), `godot_screenshot` (fixed camera views), `csharp_write`, `godot_open`. CLI: `aige godot setup/status/export/open`. | `packages/host/src/godot/tools.ts`, `packages/godot/tools/capture.gd` |
| **C# runtime for Godot** | Story (flags, inventory, objectives, waypoints), Hud (subtitles, prompts, letterbox, fades, screen-FX shader), Voice (lip-sync), Sfx, Cutscenes, AigeTest harness, EnvironmentFx, builtin third-person PlayerController and ThirdPersonCamera. | `packages/godot/runtime/` (API: `packages/godot/runtime/API.md`), test project `packages/godot/runtime-test/` |
| **Unity 6 exporter** | AIGE scene → Unity URP project: glTFast models with shared URP Lit materials (ORM repacked), an editor importer that builds `.unity` scenes and environments, and a C# runtime mirroring the Godot one (Story, Hud, Voice, Sfx, Cutscenes, components, PlayerController, ThirdPersonCamera, AigeTest). Verified with Unity 6000.5.7f1 in batch mode. | `packages/unity/`, `packages/host/src/unity/`; tools `unity_export`, `unity_screenshot`, `unity_play_test`, `unity_open`, `unity_status`; CLI `aige unity export/open/status` |
| **ArcFlare** | `aige agent --provider arcflare` uses your local ArcFlare/llama.cpp model (port from `~/.arcflare/server.json`, or `--base-url` / `ARCFLARE_URL`). `.mcp.json` registers `aige mcp`, so ArcFlare's agent and Claude Code get all AIGE tools. | `apps/cli/src/main.ts`, `.mcp.json` |

## 3. Setup

```bash
git clone https://github.com/Hakeperty/AI-Game-engine.git && cd AI-Game-engine
npm ci
npm run check                                       # Biome + type-check + vitest
node apps/cli/bin/aige.mjs godot setup              # Godot 4.7.2 .NET → ~/.aige/godot (needs .NET SDK 8+)
node apps/cli/bin/aige.mjs tts setup                # optional: voice engine (NVIDIA GPU; ~9 GB of models)
git clone <your game repo> games/<name>             # then follow the game's HANDOFF.md
```

**Using an AI:** open the engine folder in Claude Code (the root `.mcp.json` starts `aige mcp`; call `project_open` with `games/<name>`), or open the game folder itself (its own `.mcp.json` opens it directly). ArcFlare: `node apps/cli/bin/aige.mjs agent "…" -p games/<name> --provider arcflare`. Ollama: `--provider ollama --model qwen3.8:27b`.

**Server (192.168.0.142, user harry, `ssh aige-server`):** engine clone at `C:\aige` (`git pull`), Godot 4.7.2 .NET in `~/.aige/godot`. Use it for CPU-heavy work: tests, builds, headless Godot play-tests, and the local LLMs ArcFlare serves. Voice and image generation need CUDA, so keep them on the NVIDIA PC.

## 4. Unfinished work

- **Unity:** lighting is darker than in Godot, because URP has no SDFGI, SSIL, volumetric fog or auto exposure (tune the constants in `AigeLights`). A standalone player build and the runtime environment cross-fade are untested, and play-test captures miss the uGUI overlay.
- **Characters** (`packages/modeling/src/character/`): proportions, hoodie folds, hair, face and foot-planted walk/run/crouch are improved, and skinned parts now get scanned fabric materials in Godot. Still open: there is no skin texture or normal map (the face reads procedural up close), hair is solid locks rather than alpha cards, and box-UV seams show on fabrics.
- **Key exposure:** the SSH private key for the server was pasted in chat; consider rotating it.
