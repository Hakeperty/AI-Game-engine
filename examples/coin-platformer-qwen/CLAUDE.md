# AIGE game project

This folder is an AIGE game project. Build it with the `aige` MCP tools, not by hand-editing JSON.

## Workflow
1. `scene_tree` to see what exists. `api_docs` for the scripting and modeling reference.
2. Make models with `model_from_template` (fast) or `model_create` (a TypeScript recipe in models/). Always look at the `model_preview` image and fix what looks wrong.
3. Place entities with `entity_create` / `batch`. Put models on them with a MeshRenderer that uses `model`.
4. Write game logic with `script_write` (scripts/*.ts), then attach it with a Script component.
5. Verify: `render_screenshot` (look at it!), `scene_validate`, and `game_run_headless` with scripted inputs.
6. `export_web` to produce a playable build in dist/.

## Conventions
- Y is up, units are meters, rotations are Euler degrees [x, y, z].
- The default camera sits at +Z looking toward -Z. Models face +Z.
- Scenes, materials and prefabs are canonical JSON, written by the tools. Scripts and model recipes are TypeScript.
