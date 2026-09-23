# AIGE overview
AIGE is a game engine plus 3D modeler that you drive entirely through tools.
- A project has scenes (entities with components), materials, prefabs, model recipes (models/*.model.ts) and scripts (scripts/*.ts).
- Every change is undoable (`undo`) and saved to disk automatically.

## Recommended workflow
1. `scene_tree`: see what exists. `project_info`: list assets.
2. Models: `model_from_template` or `model_create` with a recipe (SDF sculpting for organic shapes).
   - Props: coin, gem, crate, platform, flag, key, door, torch, spike.
   - Nature: tree, tree-organic, rock, bush, flower, mushroom, cactus, island-terrain.
   - Creatures: blob-character, creature, slime, fish, snake, tentacle.
   ALWAYS inspect the returned preview image and fix problems (floating parts, wrong scale, inside-out, ugly colors).
3. Entities: `entity_create` / `batch` / `entity_duplicate` / `prefab_instantiate`.
   Attach models with {"type":"MeshRenderer","model":"models/x.model.ts"}.
4. Gameplay: prefer built-in behaviours via {"type":"Script","script":"builtin:PlayerController"}.
   Write custom logic with `script_write`.
5. Verify:
   - `render_screenshot` (look at it);
   - `scene_validate`;
   - `game_run_headless` with scripted inputs (check score, errors, win).
6. `export_web` for a playable build.
