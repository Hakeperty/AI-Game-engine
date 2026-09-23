# Tools

## docs
- api_docs: Read AIGE documentation. Topics: overview, conventions, components, modeling, templates, scripting, tools. Use 'modeling' before writing model recipes and 'scripting' before writing scripts.

## history
- batch: Run several tools in one call and one undo step. Later steps can use results of earlier ones with "$<step>.<field>" strings (e.g. "$0.id" is the id returned by step 0). With stopOnError (default) the whole batch is rolled back if any step fails. Only scene/material/prefab/query tools are allowed (no render/run/export).
- history: List the undo and redo stacks (newest first).
- redo: Redo changes that were undone.
- undo: Undo the last change(s). An AI turn in the editor counts as one step.

## scene
- component_add: Add a component to an entity.
- component_remove: Remove a component from an entity.
- component_update: Change properties of a component on an entity; other properties keep their values. `index` picks among multiple components of the same type (e.g. several Scripts).
- entity_create: Create an entity (game object) with optional parent, transform and components. Names are made unique among siblings. Returns the new id.
- entity_delete: Delete one or more entities and all their children.
- entity_duplicate: Duplicate an entity (with children) `count` times. Each copy is shifted by `offset` from the previous one, which makes rows of coins or platforms easy.
- entity_find: Find entities by name (substring, case-insensitive), tag, or component type.
- entity_get: Get the full data of one entity: transform, world position, components with all properties, children.
- entity_update: Change an entity: rename, move/rotate/scale, reparent (parent: null for root; world position is kept), activate/deactivate, or set tags. Only given fields change.
- scene_create: Create a new scene file and (by default) open it. template 'basic' adds a camera, a sun light and a ground plane.
- scene_list: List all scenes in the project and which one is open.
- scene_open: Make another scene the open (active) scene.
- scene_settings: Update scene settings (sky/background color, ambient light, fog, environment lighting, kill height). Only the given fields change. Fields: { background?: string, ambientColor?: string, ambientIntensity?: number = 0.4, environment?: 'none'|'studio'|'outdoor' = 'outdoor', fog?: { color?: string, near?: number = 30, far?: number = 120 } | null, killY?: number = -50 }.
- scene_tree: Show the entity hierarchy of a scene as compact text: one line per entity with id, name, position, and components. Use this first to see what exists.

## export
- export_web: Build a standalone playable web version of the game into dist/ (index.html + player.js + game-data.js; works from file:// or any static host). Models are baked to GLB and scripts are compiled. By default it smoke-tests the build in a headless browser and returns a screenshot and any errors.

## project
- file_delete: Delete a project file (undoable).
- file_list: List project files (recursively).
- file_read: Read a text file from the project (with line numbers).
- file_write: Write a text file in the project (overwrites). For scripts prefer script_write, for models model_create (they compile and check your code). Scene/material/prefab JSON is managed by the scene tools and cannot be written directly.
- project_info: Overview of the open project: name, root folder, scenes, models, scripts, materials, prefabs, and the render backend.
- project_settings: Change project settings: name, description, start scene, gravity, render options, window, and input bindings. Input actions/axes are merged by name (set an action to [] to clear it). Key codes follow KeyboardEvent.code ('KeyW', 'Space', 'ArrowLeft', 'ShiftLeft') plus 'MouseLeft', 'MouseRight', 'GamepadA/B/X/Y', 'GamepadLB/RB', 'GamepadStart'.

## verify
- game_run_headless: Play-test the game without a window: simulate N seconds with scripted input and report what happened.
- render_screenshot: Render the scene and return an image. Default views are the game camera + an isometric overview, with entity id/name labels so you can match what you see to entities. Look at it critically: floating objects, wrong scale, missing models (magenta boxes), bad lighting.
- scene_validate: Check the scene for problems: missing camera or lights, bodies without colliders, missing model/script/material files, models that fail to build, unknown built-in scripts, entities below the kill height, duplicate UI ids. Run it before play-testing.

## material
- material_create: Create a PBR material asset (materials/<name>.material.json) that MeshRenderers can reference via "material". Properties: { color?: string, metalness?: number = 0, roughness?: number = 0.6, emissive?: string, emissiveIntensity?: number = 1, opacity?: number = 1, map?: string, mapRepeat?: [x,y] = [1,1], normalMap?: string, vertexColors?: boolean = false, flatShading?: boolean = false, doubleSided?: boolean = false }.
- material_list: List material assets with their main properties.
- material_update: Change properties of an existing material; other properties keep their values.
- texture_generate: Generate a tileable procedural texture PNG (textures/<name>.png) for material maps. Kinds: checker, noise, grid, bricks, stripes, dots, wood, marble. Then set it on a material: material_create {"name":"bricks","map":"textures/bricks.png","mapRepeat":[4,4]}.

## modeling
- model_create: Write a procedural model recipe (TypeScript) to models/<name>.model.ts, build it, and return a multi-view preview image plus size, triangle count and mesh issues. The source must `export default defineModel({...})` and import from 'aige/model'. Overwrites an existing model with the same name. Read api_docs topic 'modeling' for the full API.
- model_export_glb: Export a model as a .glb file inside the project (for other tools like Blender).
- model_from_template: Create a model asset from a built-in template, optionally with new default parameters, and return a preview image. The model is saved as models/<name>.model.ts. Templates: blob-character, bush, cactus, coin, crate, creature, door, fish, flag, flower, gem, island-terrain, key, mushroom, platform, rock, slime, snake, spike, tentacle, torch, tree, tree-organic.
- model_info: Build a model (cached) and report its size, bounds, triangles, parameters, sockets, collider hint and mesh issues.
- model_preview: Render a model in a studio scene from several angles (default: iso, front, right, top) with a grid and dimensions, and return the image.
- model_templates: List the built-in model templates with their descriptions and parameters.

## prefab
- prefab_create: Save an entity and its children as a reusable prefab (prefabs/<name>.prefab.json). The root position is reset to the origin.
- prefab_instantiate: Place a copy of a prefab in the scene. Optionally give several positions to place many copies at once.

## scripting
- script_typecheck: Type-check every script and model recipe in the project. Returns diagnostics as file:line:col messages.
- script_write: Write a gameplay script (scripts/<name>.ts), compile it and type-check it against the engine API. It returns TypeScript diagnostics with file:line; fix them and write again. The script must `export default class X extends Behaviour`. Read api_docs topic 'scripting' first. Attach it with {"type":"Script","script":"scripts/<name>.ts","props":{...}}.
