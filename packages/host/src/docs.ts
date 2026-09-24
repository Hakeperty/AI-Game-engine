import { componentReference, type ToolDefinition } from '@aige/core';

/**
 * AI-facing documentation, served by the `api_docs` tool and as MCP resources (aige://docs/<topic>).
 * Keep these short, example-first, and accurate: they are prompts.
 */

export const OVERVIEW = `# AIGE overview
AIGE is a game engine plus 3D modeler that you drive entirely through tools.
- A project has scenes (entities with components), materials, prefabs, model recipes (models/*.model.ts) and scripts (scripts/*.ts).
- Every change is undoable (\`undo\`) and saved to disk automatically.

## Recommended workflow
1. \`scene_tree\`: see what exists. \`project_info\`: list assets.
2. Models: \`model_from_template\` or \`model_create\` with a recipe (SDF sculpting for organic shapes).
   - Props: coin, gem, crate, platform, flag, key, door, torch, spike.
   - Nature: tree, tree-organic, rock, bush, flower, mushroom, cactus, island-terrain.
   - Creatures: blob-character, creature, slime, fish, snake, tentacle.
   ALWAYS inspect the returned preview image and fix problems (floating parts, wrong scale, inside-out, ugly colors).
3. Entities: \`entity_create\` / \`batch\` / \`entity_duplicate\` / \`prefab_instantiate\`.
   Attach models with {"type":"MeshRenderer","model":"models/x.model.ts"}.
4. Gameplay: prefer built-in behaviours via {"type":"Script","script":"builtin:PlayerController"}.
   Write custom logic with \`script_write\`.
5. Verify:
   - \`render_screenshot\` (look at it);
   - \`scene_validate\`;
   - \`game_run_headless\` with scripted inputs (check score, errors, win).
6. \`export_web\` for a playable build.
`;

export const CONVENTIONS = `# Conventions
- Units are meters. Y is up. Rotations are Euler degrees [x, y, z] (XYZ order).
- The default camera is at +Z looking toward -Z. "Forward" for the player (move_y > 0) is -Z, away from the camera.
- Models face +Z (their front is visible from the default camera). Characters and props stand on y = 0 unless the template says otherwise.
- Colors are '#rrggbb'.
- Entities are addressed by id ('e12'), path ('Level/Platform 3') or unique name. Sibling names are made unique automatically ("Coin (2)").
- Tags mark roles: 'Player', 'Coin', 'Enemy', 'Ground', 'MainCamera'.
- Physics:
  - Collider without RigidBody = static.
  - RigidBody 'dynamic' falls.
  - CharacterController = player-style movement.
  - isTrigger colliders fire onTriggerEnter (use for pickups, goals, hazards).
- Typical sizes:
  - player 1.2–1.8 m;
  - coin radius 0.3–0.5;
  - platform 3–6 m wide;
  - jump height about 2 m with default gravity (-20).
`;

export const MODELING = `# Modeling recipes (models/<name>.model.ts)
A recipe is TypeScript that builds a mesh from code. Import everything from 'aige/model'.

\`\`\`ts
import { defineModel, p, box, cylinder, sphere, lathe, roundedBox, extrudeShape, shapes, sdf, model, curves, tube } from 'aige/model';

export default defineModel({
  name: 'lamp',
  params: { height: p.number(1.5, { min: 0.5, max: 3 }), shade: p.color('#f2d38a') },
  build({ height, shade }, { rng }) {
    const base = cylinder({ radius: 0.25, height: 0.06, segments: 32 }).translate([0, 0.03, 0]).material({ color: '#333333', metalness: 0.8, roughness: 0.4 });
    const pole = cylinder({ radius: 0.025, height }).translate([0, height / 2, 0]).material({ color: '#333333', metalness: 0.8 });
    const lampShade = lathe([[0.12, 0], [0.3, -0.25], [0.3, -0.27], [0.1, 0.02]], { segments: 32 })
      .translate([0, height + 0.1, 0]).material({ color: shade, roughness: 0.9, doubleSided: true, emissive: shade, emissiveIntensity: 0.4 });
    return model({ base: base.merge(pole), shade: lampShade }).socket('light', [0, height, 0]);
  },
});
\`\`\`

## Primitives (all centered at the origin unless noted)
- box({ size: 1 | [x,y,z], center }): faces 'top','bottom','front'(+z),'back','left','right'
- roundedBox({ size, radius, segments }): segments 1 = chamfer. Face groups as box, plus 'bevel'.
- plane({ size: [w, d], segments }): XZ plane facing +Y
- cylinder({ radius, radiusTop, height, segments }): 'side','top','bottom'
- cone({ radius, height, segments }), capsule({ radius, height }), torus({ radius, tube }): flat in XZ
- sphere({ radius, segments, rings }), icosphere({ radius, detail: 0..5 })
- lathe(profile [[r, y], ...] bottom→top, { segments, angle }): vases, bottles, coins, bowls
- extrudeShape(outline [[x, z], ...], { depth, holes, bevel }): shape extruded up along +Y
  - shapes.circle(r, n), shapes.rect(w, h, radius), shapes.star(points, outer, inner), shapes.polygon(n, r)
- sweep(profile2D, path3D, { scale, twist, closed }), tube(path, radius)
  - curves.catmullRom(points), curves.arc(r, a0, a1), curves.helix(r, h, turns), curves.line(a, b)

## Mesh methods (each returns a new mesh, so you can chain them)
- translate([x,y,z]), rotate([x,y,z] deg, pivot?), scale(s | [x,y,z]), center(), placeOnGround(y = 0), mirror('x'), flipAxis('x'), flip(), merge(...meshes)
- extrude(sel, distance, { scale, individual, direction }), inset(sel, amount), subdivide(levels, { smooth })
- displace({ amount, scale, seed, ridged }), jitter(amount), inflate(d), twist(degPerMeter), taper(start, end), bend(deg), spherize(t)
- repeat(count, offset), radial(count, { axis }), union(...), subtract(...), intersect(...): booleans need closed solids
- material({ color, metalness, roughness, emissive, emissiveIntensity, opacity, flatShading, doubleSided, texture }, sel?)
- color('#hex', sel?), gradient('y', from, to), colorBy((p, n) => '#hex'), smooth(bool), flat(), group(name, sel)
- uvBox(scale), uvPlanar('y'), uvCylindrical(), uvSpherical()
- bounds(), validate()

## Selectors (sel)
- 'top' (a face group), ['top', 'front'], or { normal: '+y', minDot: 0.7 }
- { within: { min, max } }, { above: y }, or a function (face) => boolean

## Organic modeling (creatures, plants, rocks, slimes, terrain)
Sculpt with signed distance fields (SDF): combine shapes with smooth unions, color them, then call .mesh(). SDF meshes are always watertight and manifold. Meshing takes about 0.1 to 0.7 s.

\`\`\`ts
// models/critter.model.ts
import { defineModel, eye, model, p, sdf } from 'aige/model';

export default defineModel({
  name: 'critter',
  params: { height: p.number(0.8, { min: 0.2, max: 5 }), fur: p.color('#c8622a'), belly: p.color('#f6e2c4') },
  build({ height, fur, belly }, { seed }) {
    const legs = [];
    for (const x of [-0.1, 0.1])
      for (const z of [0.14, -0.16])
        legs.push(sdf.chain([[x, 0.36, z], [x * 1.1, 0.18, z + 0.02], [x * 1.1, 0.04, z + 0.03]], [0.07, 0.055, 0.05]));
    const shape = sdf
      .smoothUnionAll(
        [
          sdf.ellipsoid([0.2, 0.18, 0.3], [0, 0.38, 0]), // body first (fastest)
          sdf.sphere(0.18, [0, 0.6, 0.26]), // head
          sdf.ellipsoid([0.08, 0.06, 0.08], [0, 0.54, 0.42]), // snout
          ...legs,
          sdf.chain([[0, 0.42, -0.28], [0, 0.55, -0.45], [0, 0.72, -0.42]], (t) => 0.04 + 0.04 * Math.sin(Math.PI * t)), // tail
          sdf.roundCone([0.1, 0.72, 0.22], [0.15, 0.86, 0.2], 0.05, 0.012).mirrorX(), // ears
        ],
        0.07,
      )
      .color(fur)
      .colorByNormal(belly, '-y', 0.2) // light belly and chin
      .colorSpots('#6b3a1e', { scale: 9, size: 0.25, seed })
      .cutBelow(0, 0.01); // flat paws on y = 0
    const s = height / 0.88;
    const eyes = [-1, 1].map((side) =>
      eye({ radius: 0.05, iris: '#3b2414' }).rotate([0, side * 16, 0]).translate([side * 0.08, 0.64, 0.4]),
    );
    return model({
      body: shape.mesh({ detail: 'high', decimate: 12000, ao: 0.6 }).scale(s).material({ roughness: 0.7 }),
      eyes: eyes[0].merge(eyes[1]).scale(s).material({ roughness: 0.15 }),
    });
  },
});
\`\`\`

SDF shapes:
- sdf.sphere(r, center), sdf.ellipsoid([rx, ry, rz], c), sdf.box(size, c, round), sdf.capsule(a, b, r, rb?), sdf.cylinder(r, h), sdf.torus(R, r), sdf.cone(r, h)
- sdf.roundCone(a, b, ra, rb): an exact tapered capsule. Use it for horns, claws, snouts and fingers.
- sdf.chain(points, radii | [r per point] | (t) => r, { curve: true, smooth }): a smooth spline tube for limbs, tails, necks, worms, tentacles and branches.
- sdf.tube(path, r | (t) => r): follows curves.helix / curves.catmullRom output.
- sdf.metaballs([{ center, radius, color? }, ...], threshold 0.5): goo that melts together.
- sdf.smoothUnionAll([body, head, ...legs], k): the fastest way to build big creatures. Put the body first.

Operators (each returns a new Sdf):
- Booleans: .smoothUnion(o, k), .union, .subtract, .smoothSubtract(o, k) (carve mouths and sockets), .intersect
- Transforms: .translate, .rotate(deg, pivot?), .scale(s), .stretch([sx, sy, sz]), .mirror('x') / .mirrorX()
- .twist(degPerMeter, axis) and .bend(degPerMeter): bend curls +Y toward +X, so build the part upright, then rotate it.
- .elongate([hx, hy, hz]), .round(r), .shell(t), .onion(t) (hollow, keeps the outside)
- .warp(amount, scale, seed): noise domain warp. Makes shapes look natural and hand-made.
- .displace(amount, scale, seed): bumps.
- .displaceBy(p => meters, maxMeters): custom ribs, rings and grooves.
- .cutBelow(y, k) / .cutAbove(y, k): flat bottoms that stand on the ground. Use k > 0 for a rounded edge.

Colors:
- .color('#hex'), .gradient('y', from, to, range?)
- .colorBy(([x, y, z], base) => '#hex')
- .colorByNoise([c1, c2], scale, seed): patches.
- .colorSpots(c, { scale, size, seed })
- .stripes([c1, c2], { direction: 'z', width, wobble })
- .colorByNormal(c, '-y', threshold): belly, underside or back.

.mesh({ detail: 'low' | 'medium' (default) | 'high' | 'ultra', resolution?, smooth: 2, decimate: 12000 | 0.5, ao: true | 0.6, colorSmooth: 1 })
- decimate is a triangle target or a ratio.
- ao bakes ambient occlusion into the vertex colors.
- Thin parts (fins, ears, petals) must be at least 2 cells thick, where one cell is the model size divided by the resolution. Use detail 'high' for them.

Mesh ops (on any mesh):
- .smoothMesh({ iterations }): Taubin smoothing that preserves volume.
- .relax()
- .brush({ center, radius, mode: 'inflate' | 'grab' | 'pinch' | 'flatten' | 'smooth' | 'noise', strength, direction })
- .decimate(n | ratio), .bakeAO({ strength }), .repairManifold()

Helpers:
- eye({ radius, iris, pupil, irisSize, pupilSize }): a crisp cartoon eye that looks along +Z. Keep eyes as a separate part.
- terrain({ size, resolution, height: number | (x, z) => y, island, slab, noise: { scale, ridged, warp }, colors, seed }): a level heightfield with sand, grass, rock and snow colors.
  - terrainHeight(sameOpts)(x, z) returns the surface height, for placing props.
- plants.tree({ length, levels, foliage: 'cloud' | 'blobs' | 'leaves', leafColor, barkColor, seed }) returns { wood, leaves }.
  - Lower-level parts: plants.branches(opts), plants.branchMesh(branches), plants.leaf({ shape: 'leaf' | 'round' | 'blade' }), plants.leaves(points, leafMesh).

Organic templates: creature, slime, fish, mushroom, bush, flower, cactus, snake (or worm), tentacle, tree-organic, island-terrain, blob-character.

## Human characters (skinned + animated)
- \`character_create\` {name, preset: 'milch'|'murphy'|'parent'|'none', params} writes models/<name>.model.ts (templates human, milch, murphy, parent). In a recipe: humanoid({ preset, height, age: 'adult'|'teen'|'child', sex, build, muscle, headShape, skin, eyes, hair: 'messy'|'short'|'buzz'|'shoulder'|'bun'|'none', hairColor, top: 'hoodie'|'tshirt'|'sweater', bottom: 'jeans'|'shorts'|'trousers', shoes: 'boots'|'sneakers'|'shoes'|'barefoot', *Color, wear, stubble, clips, detail }).
- Output: faces +Z, feet on y = 0, AIGE humanoid skeleton (hips, spine, chest, neck, head, jaw, shoulder/upperarm/forearm/hand/fingers/fingertips/thumb _l/_r, thigh/shin/foot/toe _l/_r), automatic skin weights, sockets hand_r/hand_l/head/eyes/belt/back, and every built-in clip as a glTF animation named by clip (\`animation_list\`). Check a clip with \`animation_preview\` {model, clip, frames}.

## Tips
- Keep triangle counts modest (under 20k per prop). Lower segments, or use .mesh({ decimate }) for SDF models.
- flatShading: true gives a low-poly look. Use vertex colors (color/gradient) for cheap variety.
- Return model({ partA, partB }).socket('hand', [x, y, z]).setCollider({ shape: 'capsule', radius, height, offset }) for rich models.
- Use params for anything a level designer might tweak; entities override them with MeshRenderer.params.
`;

export const SCRIPTING = `# Scripting (scripts/<name>.ts)
Scripts are TypeScript classes that extend Behaviour. Attach them with {"type":"Script","script":"scripts/name.ts","props":{...}}.

\`\`\`ts
import { Behaviour, Input, Time, Game, UI, Audio, Scene, Vector3 } from 'aige';

export default class Spinner extends Behaviour {
  static props = { speed: 90 };
  start() { Game.state.spins ??= 0; }
  update(dt: number) {
    this.entity.rotate([0, this.props.speed * dt, 0]);
    if (Input.pressed('jump')) { Game.state.spins++; UI.text('spins', \`Spins: \${Game.state.spins}\`); Audio.sfx('click'); }
  }
  onTriggerEnter(other) { if (other.hasTag('Player')) Game.win('Touched the spinner!'); }
}
\`\`\`

## Lifecycle
awake → start → per frame: fixedUpdate(dt) → physics → collision callbacks → update(dt) → lateUpdate(dt).
- Callbacks: onCollisionEnter(other, info) / onCollisionExit(other), onTriggerEnter(other) / onTriggerExit(other), onFall() (below the scene's killY), onDestroy().
- Script errors never crash the game. They are reported with file:line by game_run_headless. A behaviour is disabled after 20 errors.

## Behaviour helpers (this.)
- entity, world, props (static props merged with the Script component's props), enabled
- find(ref), findAll({ tag } | tag), getScript(Class), instantiate(prefab, { position, rotation, parent }), destroy(target = this.entity, delaySeconds?), log(...), warn(...)

## Entity API (this.entity)
- Identity: id, name, tags, hasTag / addTag / removeTag, active / setActive(b), parent, setParent(p), children, alive, destroy(delay?), respawn()
- Transforms (live):
  - position (Vector3, local), rotation (degrees: \`rotation.y += 90 * dt\` works), quaternion, scale;
  - worldPosition (get/set), forward, right, up;
  - translate([x,y,z], 'self'|'world'), rotate([x,y,z] deg), lookAt(target | entity), distanceTo(x).
- forward is +Z for objects and characters (models face +Z) and -Z for cameras and lights.
- Components and scripts: get('Light') / get(UIText) return live component props (mutations apply); getScript(Class | 'scripts/x.ts' | 'builtin:X'); addScript(Class, props)
- body (RigidBody): velocity (get/set), applyImpulse(v), applyForce(v), setPosition(v)
- character (CharacterController):
  - move([vx, 0, vz]) sets the horizontal velocity for this frame; gravity is automatic;
  - jump(speed = 8) works only when grounded (small grace period after leaving a ledge);
  - also grounded, velocity.
  - The capsule's bottom sits at the entity origin, and characters ride moving platforms.
- A Collider without a RigidBody that a script moves becomes kinematic automatically, so it pushes and carries things.
- Vectors accept [x, y, z] arrays, {x, y, z} objects or Vector3.

## Globals
- Input:
  - axis('move_x' | 'move_y') in -1..1 (move_y +1 = forward, toward -Z);
  - vector('move_x', 'move_y');
  - held / pressed / released('jump' | 'fire' | 'interact' | 'sprint' | 'pause');
  - key(code), keyPressed(code), mouseDelta.
- Time: dt, time, frame, fixedDt, timeScale (settable).
- Physics: raycast(origin, dir, maxDist = 100, { exclude, triggers }) → { entity, point, normal, distance } | null; overlapSphere(center, r).
- Audio: sfx('coin' | 'jump' | 'hit' | 'explosion' | 'powerup' | 'laser' | 'click' | 'win' | 'lose'), play(clipPath, { volume, loop, pitch }).
- UI: text(id, text, opts?) (creates the element if missing; a UIText component with that id sets style and position), show(id), hide(id).
- Game: state (shared object), emit(name, data), on(name | '*', fn) (returns an unsubscribe function), win(msg), lose(msg), over, restart().
- Scene: find(ref), findAll({ tag, name }), instantiate('prefabs/x.prefab.json' | entity, { position }), destroy(e), load('level2').
- Random (seeded): value, range, int, pick, chance, shuffle, insideCircle. Debug.log(...). Don't use Math.random: it breaks deterministic play-tests.
- Math: Vector3, Quaternion, Euler, Color, MathUtils (three.js).

## Built-in behaviours ("builtin:<Name>")
- PlayerController { speed: 6, sprintMultiplier: 1.6, jumpSpeed: 9, turnSpeed: 12, cameraRelative: true, respawnOnFall: true }: use it with a CharacterController and the 'Player' tag.
- FollowCamera { target: 'Player', offset: [0,5,9], smooth: 6, lookAtOffset: [0,1,0] }: put it on the Camera entity.
- Collectible { scoreKey: 'score', value: 1, sfx: 'coin', playerTag: 'Player', spin: true }: needs a trigger Collider. It emits 'collect', and 'allCollected' when none are left.
- HudText { id: 'score', format: 'Score: {score}' }: keeps a UIText in sync with Game.state.
- Goal { playerTag: 'Player', requireAll: null | 'Coin' | true, message: 'You win!' }: needs a trigger Collider and calls Game.win.
- Hazard { playerTag: 'Player', action: 'respawn' | 'lose' }
- MovingPlatform { offset: [0,0,4], duration: 3 }, Rotator / Spinner { speed: [0,90,0] }, Bobber { height: 0.25, speed: 2 }, Lifetime { seconds: 5 }

## A complete player + pickup setup (no custom code)
- Player: MeshRenderer, CharacterController, Script builtin:PlayerController, tag 'Player'.
- Camera: Camera, Script builtin:FollowCamera.
- Coin: MeshRenderer, Collider { shape: 'sphere', isTrigger: true }, Script builtin:Collectible, tag 'Coin'.
- HUD: UIText { id: 'score' } + Script builtin:HudText.
- Goal: MeshRenderer (flag), Collider { isTrigger: true }, Script builtin:Goal { requireAll: 'Coin' }.
`;

export function componentsDoc(): string {
  return `# Components\nAdd with component_add, or in entity_create's "components" array: {"type": "...", ...props}.\n\n${componentReference()}\n`;
}

export function toolsDoc(tools: ToolDefinition[]): string {
  const groups = new Map<string, ToolDefinition[]>();
  for (const t of tools) {
    const list = groups.get(t.group) ?? [];
    list.push(t);
    groups.set(t.group, list);
  }
  let out = '# Tools\n';
  for (const [g, list] of groups) {
    out += `\n## ${g}\n`;
    for (const t of list) out += `- ${t.name}: ${t.description.split('\n')[0]!.replace(/ Example:.*/, '')}\n`;
  }
  return out;
}

export const DOC_TOPICS = [
  'overview',
  'conventions',
  'components',
  'modeling',
  'templates',
  'scripting',
  'tools',
] as const;
export type DocTopic = (typeof DOC_TOPICS)[number];
