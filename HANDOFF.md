# AIGE + The Sidle of Milch: hand-off

This file is a snapshot of where AIGE and The Sidle of Milch stand, written so you (or any AI agent: Claude Code, ArcFlare's agent, etc.) can pick up locally. It covers what was built, how to run it, what is unfinished, and what to do next. Last updated 2026-09-24.

---

## 1. The big picture

- **AIGE** (this repo) is an AI-native "Unity + Blender in one", written in TypeScript. It does procedural modeling, scenes, voice acting, cutscene documents and MCP tools.
- **Games run on Godot 4.7 .NET, with game code in C#.** You asked for C# instead of web languages and for realistic graphics, so AIGE is now the authoring layer and exports each game as a Godot C# project (native exe, SDFGI global illumination, volumetric fog, and so on). The older TypeScript/Three.js runtime remains for fast previews.
- **The game is The Sidle of Milch** (`games/sidle-of-milch/`): a realistic third-person story RPG, story by Harry.
  - Chapter 1 takes place in a run-down timber cabin at night in a storm; the production script is in `games/sidle-of-milch/STORY.md`.
  - **Art direction:** realistic (Elden Ring / Zelda feel). Per your latest request, it is set in **rural Ireland**.

## 2. What was done (this session)

### Engine (AIGE)

| Area | What | Where |
|---|---|---|
| **Voice acting** | Local **Qwen3-TTS** server (VoiceDesign plus Base voice cloning). Every take is verified with **Whisper** (transcript WER), **WavLM speaker similarity** to the character's reference voice, and pitch-drift scoring, and the best take is kept. Output is Ogg plus a VoiceLineDoc with a 30 fps lip-sync mouth curve. | `tools/tts/server.py`, `packages/host/src/voice/*`, `aige tts setup/status/stop`; tools `voice_design`, `voice_line(s)`, `voice_list`, `tts_status` |
| **Realistic assets** | Poly Haven CC0 search and download (scanned PBR textures become material docs at real-world scale, plus HDRIs and glTF models). Models are made game-ready (foliage cards thinned, meshes simplified to a triangle budget), and every asset is credited in the game's CREDITS.md. | `packages/host/src/assets/polyhaven.ts`; tools `asset_search`, `asset_fetch` |
| **Materials** | MaterialDoc gained `ormMap`, `normalScale` and `aoIntensity`. MeshRenderer gained per-part `materials`. | `packages/core/src/schema/*` |
| **Environment** | Realistic look settings: HDRI sky, SDFGI, SSIL, volumetric fog, auto exposure (eye adaptation), grade, vignette and grain. | `packages/core/src/schema/environment.ts` |
| **Cutscenes / story schemas** | CutsceneDoc (camera, animation, move, voice, sound, subtitle, fx incl. `volume`, light, event) and VoiceLineDoc. Components: Interactable, Door, Trigger, ParticleSystem, Animator. | `packages/core/src/schema/documents.ts`, `components.ts` |
| **Godot exporter** (new package) | AIGE scene → `.tscn` with exact transforms, bodies/colliders (incl. trimesh), lights, audio and components. It bakes GLBs with embedded PBR materials and turns off shadows for glass. Also writes environment `.tres` resources (switchable at runtime), project.godot (input map, Jolt, high-quality render settings), csproj, and export presets. It bakes ambience/SFX audio, copies the C# runtime, then runs `dotnet build` and a Godot import. | `packages/godot/` (contract: `packages/godot/README.md`), `packages/host/src/godot/*` |
| **Godot tools** | `godot_export`, `godot_play_test` (headless scripted play-tests with an event report), `godot_screenshot` (fixed camera views; works even if the C# fails to compile), `csharp_write` (write a C# script and compile it), `godot_open`. CLI: `aige godot setup/status/export/open`. | `packages/host/src/godot/tools.ts`, `packages/godot/tools/capture.gd` |
| **C# runtime for Godot** | Story (flags, inventory, objectives, delayed waypoint), Hud (subtitles, prompts, objective, letterbox, fades, screen-FX shader), Voice (lip-sync), Sfx, Cutscenes (full CutsceneDoc player), AigeTest harness, components, and the builtin realistic third-person PlayerController and ThirdPersonCamera. Verified: 0 build warnings, and headless and windowed harness runs are OK. | `packages/godot/runtime/` (API: `packages/godot/runtime/API.md`), test project `packages/godot/runtime-test/` |
| **Animation core** | Skeleton, pose rig, and a clip library for the story animations. Humanoid characters, skin weights and glTF skin/animation export were **still in progress** (see §5). | `packages/core/src/animation/`, `packages/modeling/src/character/` |
| **ArcFlare** | `aige agent --provider arcflare` uses your local ArcFlare/llama.cpp model: it reads the port from `~/.arcflare/server.json`, or takes `--base-url` or `ARCFLARE_URL`, and picks the loaded model automatically. `.mcp.json` at the repo root registers `aige mcp`, so **ArcFlare's agent and Claude Code get all AIGE tools** when started in this folder. | `apps/cli/src/main.ts`, `.mcp.json` |

### The game (`games/sidle-of-milch/`)

- **Story and voice:** STORY.md is the full Chapter 1 script (10 beats, 22 voice lines). Milch's voice is designed (18-year-old, soft, husky, tired), and **all 22 Chapter 1 lines are generated** in `audio/voice/`. Two need a redo: `milch_scream_2` isn't screamed, and `milch_stairs_open` was misheard.
- **Models (procedural recipes):**
  - Architecture: `log-wall` (doorways and windows with trimesh collision), `slab`, `stairs`, `door`.
  - Furniture: `furniture` (18 kinds).
  - Story props: `props` (photo frames, knife, knife stuck in the floor, toothbrush cup, **shield with a Newgrange triple spiral**, bulb, cobweb, dirt, rug, toys).
  - **Irish details:** `irish` (Sacred Heart picture, red Sacred Heart lamp, St. Brigid's cross, holy water font, painted dresser with blue-and-white delph, range cooker with flue, kettle, teapot, turf basket, rosary, súgán chairs).
  - Landscape: `drystone-wall` (Irish field wall).
- **Scanned materials and models:** log wood, old floor, dirty planks, cabinet and table wood, wool blanket, mud, lichen stone and field grass. HDRIs: moonlit night, autumn forest, and a cloudy Atlantic cliffside. Two windswept coastal trees are simplified from 2M to 78k triangles.
- **The house:** `build/house.ts` builds `scenes/house.scene.json` through the tool API. Run `node games/sidle-of-milch/build/house.ts`. It contains:
  - both floors, with rooms per STORY.md;
  - locked doors (the stairs unlock on a flag);
  - night lighting (moon through the windows, flickering bulbs, faint bounce fills);
  - a lightning light, and a morning setup that starts inactive;
  - ambience (storm, rain on the windows, fridge hum, creaks, morning birds);
  - dust particles;
  - all story triggers and interactables.
- **Verified in Godot:** real renders show the moonbeam through the bedroom window, the warm kitchen under its bulb, and the dark upper hallway, all readable with auto exposure and fills. A headless play-test moved Milch, interacted with Photo 1 and set its flag.

## 3. Continue locally: setup

```bash
git clone https://github.com/Hakeperty/AI-Game-engine.git && cd AI-Game-engine
npm ci
npx tsx scripts/typecheck.ts && npx vitest run      # checks
node apps/cli/bin/aige.mjs godot setup              # Godot 4.7.2 .NET → ~/.aige/godot (needs .NET SDK 8+)
node apps/cli/bin/aige.mjs tts setup                # optional: voice engine (NVIDIA GPU; ~9 GB of models)
```

Build and run the game:

```bash
node games/sidle-of-milch/build/house.ts                                  # (re)build the house scene
node apps/cli/bin/aige.mjs godot export -p games/sidle-of-milch           # export → Godot project + dotnet build
node apps/cli/bin/aige.mjs godot open -p games/sidle-of-milch             # open in the Godot editor, press F5
node apps/cli/bin/aige.mjs call godot_screenshot '{"scene":"house","views":[{"position":[-1.8,1.6,-0.7],"target":[-4.5,0.9,-2.8]}]}' -p games/sidle-of-milch --out shot.png
```

The game folder is also the Godot project. Generated parts (`addons/aige`, `godot/`, `.godot/`) are git-ignored, so run `godot export` after cloning. Write game code in C# under `games/sidle-of-milch/scripts/` (for example with the `csharp_write` tool).

**Using an AI to continue:**
- **Claude Code:** open the repo; `.mcp.json` loads the AIGE tools automatically.
- **ArcFlare:** `arcflare`, pick "ArcFlare agent" in this folder (it reads `.mcp.json`). Or run `node apps/cli/bin/aige.mjs agent "…" -p games/sidle-of-milch --provider arcflare`.
- **Ollama:** `--provider ollama --model qwen3.8:27b`.

**Server (Ms-M1-MAX-ai, 192.168.0.142, user harry, `ssh aige-server`):**
- Repo clone at `C:\aige` (`git pull` to update), with Godot 4.7.2 .NET in `~/.aige/godot`.
- Best used for CPU-heavy work: tests, builds, headless Godot play-tests, and the local LLMs that ArcFlare serves (32 GB of GPU memory).
- Keep voice generation (Qwen3-TTS needs CUDA) on the NVIDIA PC.

## 4. Next steps (in order)

1. **Cutscene documents** in `games/sidle-of-milch/cutscenes/`. The scene references these; none exist yet:
   - `cs1_wake`: started by Chapter1.cs at game start.
   - `photo_1`, `cs2_hall`, `cs3_kitchen`: open the drawer, knife, fridge photo, thunder and lightning.
   - `cabinet`: toothbrushes.
   - `cs4_empty`: "Murphy?", then the faint: fx heartbeat, then volume, darken and fade.
   - `cs5_morning`: `emit env:res://godot/environments/house-Environment_Morning.tres`; enable Sun, Birds and Knife_Stuck; disable the Night group.
   - `cs6_leave`: end of the chapter.
   - Schema: `CutsceneDoc` in `packages/core/src/schema/documents.ts`.
2. **`scripts/Chapter1.cs`** (game logic in C#):
   - When `found_bathroom` and `found_storage` are both set, set `stairs_unlocked`, play `milch_stairs_open`, and set the objective "Find Murphy's room" with a pointer after ~25 s.
   - Play cs1 at start, and cs5 after cs4 ends.
   - After cs5, set `leave_cabin`.
   - API: `packages/godot/runtime/API.md`.
3. **Place the Irish props** in `build/house.ts`:
   - súgán chairs at the round table;
   - dresser on the kitchen east wall, and the range with kettle against the kitchen/storage wall;
   - Sacred Heart picture with the red lamp on the kitchen west wall;
   - St. Brigid's cross over the front door, and the holy water font beside it;
   - rosary on the bedroom nightstand, and a turf basket by the range.
   - Outside: field grass ground, drystone walls, and the two coastal trees. Switch the morning HDRI to `cloudy_cliffside_road_2k.hdr`.
4. **Characters:**
   - Finish the humanoid generator, skinning and GLB skin/animation export (in `packages/modeling/src/character/`).
   - Make `models/milch.model.ts` (plus Murphy and the parent) and replace Milch's placeholder capsule.
   - Hook the Animator up to the story clips.
5. **Photos:** render Milch, Murphy and the parent together, tear the parent's head out of the image (paper-tear edge, sepia), and save it as `textures/photo1.png` and `photo2.png`. Then point `materials/photo1.material.json` and `photo2` `map` at them.
6. **Voice:** regenerate `milch_scream_2` (try text "MURPHY!!" with instruct "screaming at the top of his lungs") and `milch_stairs_open`. Optionally, redesign Milch's voice with a soft **Irish accent** and regenerate all lines: `voice_design` then `voice_lines`, about 10 min on the 5070 Ti.
7. **Other fixes:**
   - Improve the storage-room coats, which are blobby.
   - Add curtains and more kitchen clutter.
   - Run `aige godot export` and a full `godot_play_test` of Chapter 1, then iterate on the look with `godot_screenshot`.

## 5. Unfinished work and known issues

- **Characters:** the characters/animation subagent was mid-way through the humanoid generator (hair, clothing).
  - `packages/modeling/templates.test.ts` fails on `human.model.ts/tshirt watertight`.
  - Biome warns about 2 unused variables in `packages/modeling/src/character/body.ts`.
  - The glTF extension registration in `packages/modeling/src/export/gltf.ts` (needed so `model_preview` can read Poly Haven GLBs) was requested but may not be done yet.
- **Headless play-test error:** it reports the missing `res://cutscenes/photo_1.cutscene.json`. That is expected until step 4.1.
- **Birds at night:** they played at the start because inactive entities still ran. The exporter now writes `process_mode = 4` for inactive entities; re-export to pick it up.
- **Lighting:** first-time `godot export` imports take about 2.5 min (textures); later ones are incremental. SDFGI needs the auto exposure and fill lights to keep dark rooms readable; see `Fill_*` in `build/house.ts`.
- **Key exposure:** the SSH private key for the server was pasted in chat; consider rotating it.
