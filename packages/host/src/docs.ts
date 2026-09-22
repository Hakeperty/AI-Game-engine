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
2. Models: \`model_from_template\` (coin, gem, crate, platform, tree, rock, blob-character, flag, key, door, torch, spike) or \`model_create\` with a recipe.
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

## SDF sculpting (organic shapes)
Available shapes:
- sdf.sphere(r, center), sdf.ellipsoid([rx, ry, rz], c), sdf.box(size, c, round)
- sdf.capsule(a, b, r, rb?), sdf.cylinder(r, h), sdf.torus(R, r), sdf.cone(r, h)

Chain these onto a shape:
- .smoothUnion(other, k), .union, .subtract, .smoothSubtract, .intersect
- .translate, .rotate, .scale, .round(r), .shell(t), .displace(amount, scale, seed), .mirrorX()
- .color('#hex') or .colorBy(p => '#hex')

When the shape is finished, call .mesh({ resolution: 48 }) to get a regular mesh.

## Tips
- Keep triangle counts modest (under 20k per prop). Lower segments or SDF resolution if needed.
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
Callbacks: onCollisionEnter/Exit(other), onTriggerEnter/Exit(other), onFall() (below the scene's killY), onDestroy().

## Entity API (this.entity)
- id, name, tags, hasTag(t), active, setActive(b), parent, children
- position (Vector3, local), worldPosition, rotation, quaternion, scale
- forward, right, up, translate([x,y,z]), rotate([x,y,z] deg), lookAt(target)
- get('Light') returns the live component props; getScript(Class); destroy()
- body: velocity, applyImpulse, applyForce, setPosition (entities with a RigidBody)
- character: move([vx, 0, vz], dt), jump(speed), grounded, velocity (entities with a CharacterController)

## Globals
- Input: axis('move_x' | 'move_y'), held/pressed/released('jump' | 'fire' | 'interact' | 'sprint'), key(code)
- Time: dt, time, frame
- Physics: raycast(origin, dir, maxDist)
- Audio: sfx('coin' | 'jump' | 'hit' | 'explosion' | 'powerup' | 'laser' | 'click' | 'win' | 'lose'), play(path)
- UI: text(id, text), show(id, visible). A UIText component with the same id defines the style and position.
- Game: state (shared object), emit(name, data), on(name, fn), win(msg), lose(msg), restart()
- Scene: find(ref), findAll({ tag }), instantiate(prefab, { position }), destroy(e), load(name)
- Random: range, int, pick, chance (seeded). Debug.log(...).
- Math: Vector3, Quaternion, Euler, Color, MathUtils (three.js)

## Built-in behaviours ("builtin:<Name>")
- PlayerController { speed: 6, jumpSpeed: 9, sprintMultiplier: 1.6, cameraRelative: true, respawnOnFall: true }: needs a CharacterController
- FollowCamera { target: 'Player', offset: [0,5,9], smooth: 6 }: put it on the camera
- Collectible { scoreKey: 'score', value: 1, sfx: 'coin' }: trigger collider plus 'Coin' tag
- HudText { id: 'score', format: 'Score: {score}' }: on an entity with a UIText
- Goal { message: 'You win!', requireAll: null | 'Coin' }, Hazard { action: 'respawn' | 'lose' }
- Rotator { speed: [0,90,0] }, Bobber { height, speed }, MovingPlatform { offset, duration }, Lifetime { seconds }
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

export const DOC_TOPICS = ['overview', 'conventions', 'components', 'modeling', 'templates', 'scripting', 'tools'] as const;
export type DocTopic = (typeof DOC_TOPICS)[number];
