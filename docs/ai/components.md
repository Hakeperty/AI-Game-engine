# Components
Add with component_add, or in entity_create's "components" array: {"type": "...", ...props}.

- MeshRenderer: Renders a mesh. Use `model` for a procedural recipe ('models/x.model.ts') or a '.glb' file, or `primitive` for a unit-size built-in shape (scale it with the transform).
  { model?: string, params?: Record<string, any>, primitive?: 'box'|'sphere'|'cylinder'|'cone'|'capsule'|'plane'|'torus', material?: string, color?: string, castShadow?: boolean = true, receiveShadow?: boolean = true, visible?: boolean = true }
- Light: A light source. Directional lights shine along the entity forward (-Z rotated by the transform); a rotation of [-50, 30, 0] gives a nice sun.
  { kind?: 'directional'|'point'|'spot'|'ambient'|'hemisphere' = 'directional', color?: string, intensity?: number = 1, groundColor?: string, range?: number = 0, angle?: number = 30, castShadow?: boolean = false }
- Camera: A perspective camera looking along the entity forward direction (-Z). The primary camera is used when the game runs.
  { fov?: number = 60, near?: number = 0.1, far?: number = 500, primary?: boolean = true }
- RigidBody: Makes the entity take part in physics. 'dynamic' bodies fall and collide, 'fixed' never move, 'kinematic' are moved by scripts. Needs a Collider.
  { kind?: 'dynamic'|'fixed'|'kinematic' = 'dynamic', mass?: number = 1, linearDamping?: number = 0, angularDamping?: number = 0.05, gravityScale?: number = 1, lockRotation?: boolean = false, ccd?: boolean = false }
- Collider (multiple allowed): Collision shape. 'auto' fits a box to the mesh bounds. Sizes are in local space before the entity scale. Set isTrigger for pickups/zones (fires onTriggerEnter, no collision response).
  { shape?: 'auto'|'box'|'sphere'|'capsule'|'cylinder'|'convex'|'mesh' = 'auto', size?: [x,y,z] = [1,1,1], radius?: number = 0.5, height?: number = 1, offset?: [x,y,z] = [0,0,0], isTrigger?: boolean = false, friction?: number = 0.5, restitution?: number = 0 }
- CharacterController: Kinematic capsule character that walks, climbs steps, slides along walls and snaps to the ground. Move it from a script with `this.entity.character.move(velocity, dt)`, or add the built-in script 'builtin:PlayerController'.
  { height?: number = 1.8, radius?: number = 0.4, stepHeight?: number = 0.35, maxSlope?: number = 50, snapToGround?: number = 0.3 }
- Script (multiple allowed): Attaches a behaviour. `script` is a project script ('scripts/player.ts', exporting a default class extending Behaviour) or a built-in ('builtin:Rotator'). `props` override the script's static props.
  { script: string, props?: Record<string, any> = {}, enabled?: boolean = true }
- AudioSource (multiple allowed): Plays a sound. Use `clip` for an audio file or `sfx` for a synthesized preset (no files needed).
  { clip?: string, sfx?: 'coin'|'jump'|'hit'|'explosion'|'powerup'|'laser'|'click'|'win'|'lose', volume?: number = 0.8, loop?: boolean = false, playOnStart?: boolean = false, spatial?: boolean = false }
- UIText: Screen-space text overlay (HUD). Update from scripts with `UI.text(id, text)` or `this.entity.get(UIText)`.
  { text?: string = '', anchor?: 'top-left'|'top'|'top-right'|'left'|'center'|'right'|'bottom-left'|'bottom'|'bottom-right' = 'top-left', offset?: [x,y] = [16,16], fontSize?: number = 24, color?: string, id?: string }
