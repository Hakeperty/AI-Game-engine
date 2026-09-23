# Scripting (scripts/<name>.ts)
Scripts are TypeScript classes that extend Behaviour. Attach them with {"type":"Script","script":"scripts/name.ts","props":{...}}.

```ts
import { Behaviour, Input, Time, Game, UI, Audio, Scene, Vector3 } from 'aige';

export default class Spinner extends Behaviour {
  static props = { speed: 90 };
  start() { Game.state.spins ??= 0; }
  update(dt: number) {
    this.entity.rotate([0, this.props.speed * dt, 0]);
    if (Input.pressed('jump')) { Game.state.spins++; UI.text('spins', `Spins: ${Game.state.spins}`); Audio.sfx('click'); }
  }
  onTriggerEnter(other) { if (other.hasTag('Player')) Game.win('Touched the spinner!'); }
}
```

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
  - position (Vector3, local), rotation (degrees: `rotation.y += 90 * dt` works), quaternion, scale;
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
