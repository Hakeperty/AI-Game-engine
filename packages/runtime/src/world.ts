import {
  AigeError,
  type ComponentData,
  defaultInputMap,
  didYouMean,
  type Entity,
  type PrefabDoc,
  type ProjectDoc,
  type SceneDoc,
} from '@aige/core';
import { Object3D } from 'three';
import { type AudioBackend, isSfxPreset, NullAudio, type PlayOptions } from './audio.ts';
import { type Behaviour, type BehaviourClass, constructBehaviour } from './behaviour.ts';
import { builtinBehaviours } from './builtins.ts';
import { enterWorld, exitWorld } from './context.ts';
import { RuntimeEntity } from './entity.ts';
import { InputState, type InputSource, NullInput } from './input.ts';
import {
  cloneJson,
  cloneProps,
  DEG,
  formatArg,
  hashString,
  numOr,
  quatToEulerDeg,
  Rng,
  round,
  roundV,
  stableStringify,
  toPlain,
  vec3Or,
} from './math.ts';
import {
  type CollisionInfo,
  type ContactEvent,
  initPhysics,
  type PhysicsHost,
  PhysicsWorld,
} from './physics.ts';
import {
  type AudioEvent,
  type GameEvent,
  type GameOver,
  type HudEntry,
  type LogEntry,
  type ModelInfo,
  type RotationLike,
  SFX_PRESETS,
  type SceneLoadEvent,
  type ScriptError,
  type SfxPreset,
  type UIAnchor,
  type Vec3Like,
} from './types.ts';

export interface WorldOptions {
  scene: SceneDoc;
  project: ProjectDoc;
  /** Project-relative path of `scene` (default: project.startScene). Used by Scene.load / restart. */
  scenePath?: string;
  /** Other scenes Scene.load() may switch to, keyed by path ('scenes/level2.scene.json'). */
  scenes?: Record<string, SceneDoc>;
  /** Prefabs keyed by path ('prefabs/coin.prefab.json'). */
  prefabs?: Record<string, PrefabDoc>;
  /** Compiled scripts: path ('scripts/player.ts') -> default-exported Behaviour class. */
  scripts: Record<string, BehaviourClass>;
  /** Model info for the scene's entities, keyed by entity id. */
  models?: Record<string, ModelInfo>;
  /** Model info by model asset path (used for instantiated prefabs and other scenes). */
  modelInfoForPath?: (path: string) => ModelInfo | undefined;
  input?: InputSource;
  audio?: AudioBackend;
  /** Seed for Random (default 1). */
  seed?: number;
  /** Maps a thrown script error to a message and stack (e.g. with source maps). */
  formatError?: (error: unknown, script: string) => { message: string; stack?: string };
  /** A behaviour is disabled after this many errors (default 20). */
  maxErrorsPerBehaviour?: number;
  /** Maximum fixed steps per update() call (default 8). */
  maxStepsPerFrame?: number;
}

export interface InstantiateOptions {
  /** World-space position of the new root (default: the prefab's own transform). */
  position?: Vec3Like;
  /** World-space rotation (Euler degrees, Quaternion or three.js Euler). */
  rotation?: RotationLike;
  /** Parent entity (or ref). Default: scene root. */
  parent?: RuntimeEntity | string | null;
  /** Name for the new root entity. */
  name?: string;
}

export interface FindQuery {
  tag?: string;
  name?: string;
}

export interface WorldEvents {
  spawned: RuntimeEntity;
  destroyed: RuntimeEntity;
  log: LogEntry;
  error: ScriptError;
  game: GameEvent;
  sceneLoad: SceneLoadEvent;
  audio: AudioEvent;
}

/** Everything that changed since the last drainChanges() (for renderers). */
export interface WorldChanges {
  spawned: RuntimeEntity[];
  destroyed: string[];
  /** Entity ids whose components were mutated through entity.get(...). */
  components: string[];
  /** Entity ids whose active flag changed. */
  active: string[];
  /** A scene was (re)loaded: rebuild everything from snapshotScene(). */
  sceneLoaded: boolean;
}

interface BehaviourRecord {
  inst: Behaviour;
  entity: RuntimeEntity;
  script: string;
  awoken: boolean;
  started: boolean;
  dead: boolean;
  errors: number;
}

interface GameListener {
  name: string;
  fn: (data: any, name: string) => void;
  owner: BehaviourRecord | null;
}

interface HudLink {
  entity: RuntimeEntity;
  comp: ComponentData;
  lastText: string;
  shown: boolean;
}

type EntityDoc = Pick<Entity, 'id' | 'name' | 'parent'> & Partial<Entity>;

const RESERVED_FIELDS = new Set(['entity', 'world', 'props', 'enabled', 'script']);
const ANCHORS: UIAnchor[] = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
];

function defaultFormatError(err: unknown): { message: string; stack?: string } {
  const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null;
  if (e && typeof e === 'object' && typeof e.message === 'string') {
    const name =
      typeof e.name === 'string' && e.name !== 'Error' && e.name !== 'AigeError' ? `${e.name}: ` : '';
    const hint = typeof (e as any).hint === 'string' ? ` (${(e as any).hint})` : '';
    const stack =
      typeof e.stack === 'string'
        ? e.stack
            .split('\n')
            .filter((l) => /^\s+at /.test(l))
            .slice(0, 8)
            .map((l) => l.trim())
            .join('\n')
        : undefined;
    return { message: `${name}${e.message}${hint}`, stack };
  }
  return { message: String(err) };
}

/**
 * A running game. Builds runtime entities from a SceneDoc, runs behaviours, steps Rapier physics and
 * tracks HUD, audio and game state. Runs headless in Node and in the browser.
 *
 * Frame order: input -> awake/start of new behaviours -> N x (fixedUpdate -> physics -> collision and
 * trigger callbacks -> kill-height check) -> update -> lateUpdate -> deferred destroys -> scene loads.
 */
export class World {
  readonly project: ProjectDoc;
  readonly fixedDt: number;
  /** Identity root holding every entity's Object3D. */
  readonly root = new Object3D();
  readonly entities = new Map<string, RuntimeEntity>();
  /** HUD elements by id (from UIText components and UI.text()). */
  readonly hud: Record<string, HudEntry> = {};
  /** Game.state. */
  readonly gameState: Record<string, any> = {};
  gameOver: GameOver | null = null;
  /** Simulated seconds (scaled). */
  time = 0;
  /** Unscaled seconds (drives scripted input). */
  realTime = 0;
  frame = 0;
  /** Current phase dt (fixedDt in fixedUpdate, frame dt in update). */
  dt = 0;
  timeScale = 1;
  readonly input: InputState;
  audio: AudioBackend;
  readonly random: Rng;
  physics: PhysicsWorld;
  /** Logs and errors emitted while the world was created (before the first frame), e.g. missing scripts. */
  readonly startup: { logs: LogEntry[]; errors: ScriptError[] } = { logs: [], errors: [] };

  private readonly opts: WorldOptions;
  private sceneDoc: SceneDoc;
  private scenePath: string | null;
  private readonly initialScene: SceneDoc;
  private readonly initialPath: string | null;
  private usingInitialModels = true;
  private readonly spawnedIds = new Set<string>();
  private nextId = 1;
  private records: BehaviourRecord[] = [];
  private recordOf = new Map<Behaviour, BehaviourRecord>();
  private currentRecord: BehaviourRecord | null = null;
  private readonly listeners = new Map<keyof WorldEvents, Set<(e: any) => void>>();
  private gameListeners: GameListener[] = [];
  private destroyQueue: RuntimeEntity[] = [];
  private delayed: { entity: RuntimeEntity; at: number }[] = [];
  private pendingLoad: { doc: SceneDoc; path: string | null; restart: boolean } | null = null;
  private pendingAudio: { entity: RuntimeEntity; comp: ComponentData }[] = [];
  private readonly hudLinks = new Map<string, HudLink>();
  private readonly warned = new Set<string>();
  private accumulator = 0;
  private phase: 'idle' | 'fixed' | 'physics' | 'events' | 'update' | 'late' = 'idle';
  private disposed = false;
  private booting = false;
  private readonly maxErrors: number;
  private readonly maxSteps: number;
  private changes: WorldChanges = {
    spawned: [],
    destroyed: [],
    components: [],
    active: [],
    sceneLoaded: false,
  };
  private readonly dirtyComponents = new Set<string>();
  private readonly activeChanged = new Set<string>();
  private readonly physicsHost: PhysicsHost;

  /** Creates a world and runs every behaviour's awake() and start(). */
  static async create(opts: WorldOptions): Promise<World> {
    await initPhysics();
    const world = new World(opts);
    world.boot();
    return world;
  }

  private constructor(opts: WorldOptions) {
    if (!opts?.scene || !Array.isArray(opts.scene.entities)) {
      throw new AigeError('INVALID_INPUT', 'World.create needs a SceneDoc in `scene`.', {
        hint: "Pass { scene, project, scripts } where scene is an 'aige.scene' document.",
      });
    }
    if (!opts.project) {
      throw new AigeError('INVALID_INPUT', 'World.create needs the ProjectDoc in `project`.', {
        hint: 'Use createProjectDoc(name) for tests.',
      });
    }
    this.opts = opts;
    this.project = opts.project;
    this.fixedDt = Math.min(0.1, Math.max(1 / 1000, numOr(opts.project.physics?.fixedTimestep, 1 / 60)));
    this.maxErrors = Math.max(1, opts.maxErrorsPerBehaviour ?? 20);
    this.maxSteps = Math.max(1, opts.maxStepsPerFrame ?? 8);
    this.sceneDoc = opts.scene;
    this.initialScene = opts.scene;
    this.scenePath = opts.scenePath ?? opts.project.startScene ?? null;
    this.initialPath = this.scenePath;
    this.random = new Rng(opts.seed ?? 1);
    this.audio = opts.audio ?? new NullAudio();
    this.root.name = 'World';
    this.physicsHost = {
      root: this.root,
      modelInfo: (e) => this.modelInfo(e),
      warnOnce: (k, m) => this.warnOnce(k, m),
      inFixedPhase: () => this.phase === 'fixed' || this.phase === 'events' || this.phase === 'physics',
    };
    this.physics = this.newPhysics();
    this.input = new InputState(
      opts.project.input ?? defaultInputMap(),
      opts.input ?? new NullInput(),
      (k, m) => this.warnOnce(k, m),
    );
  }

  private newPhysics(): PhysicsWorld {
    return new PhysicsWorld(
      this.physicsHost,
      vec3Or(this.project.physics?.gravity, [0, -20, 0]),
      this.fixedDt,
    );
  }

  private boot(): void {
    const prev = enterWorld(this);
    this.booting = true;
    try {
      this.buildScene(this.sceneDoc);
    } finally {
      this.booting = false;
      exitWorld(prev);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------------------------

  get sceneName(): string {
    return this.sceneDoc.name;
  }

  /** The source document of the running scene. */
  get scene(): SceneDoc {
    return this.sceneDoc;
  }

  /** Project-relative path of the running scene, when known. */
  get scenePathName(): string | null {
    return this.scenePath;
  }

  /**
   * Advances the game by a real frame time (seconds). Runs as many fixed steps as the accumulated
   * (scaled) time allows, then update() and lateUpdate() once.
   */
  update(frameDt: number): void {
    if (this.disposed) return;
    const dt = Number.isFinite(frameDt) ? Math.max(0, Math.min(frameDt, 0.25)) : 0;
    this.accumulator += dt * this.timeScale;
    this.runFrame(dt, dt * this.timeScale, () => {
      let steps = 0;
      while (this.accumulator >= this.fixedDt - 1e-9 && steps < this.maxSteps) {
        this.fixedStep();
        this.accumulator -= this.fixedDt;
        steps++;
      }
      if (steps >= this.maxSteps && this.accumulator > this.fixedDt) this.accumulator = 0;
    });
  }

  /** Advances exactly one fixed step (plus one update/lateUpdate with dt = fixedDt). */
  step(): void {
    if (this.disposed) return;
    this.runFrame(this.fixedDt, this.fixedDt, () => this.fixedStep());
  }

  /** Replaces the input source (e.g. a ScriptedInput for play-tests). */
  setInput(source: InputSource): void {
    this.input.setSource(source);
  }

  /** Subscribes to a world event. Returns an unsubscribe function. */
  on<K extends keyof WorldEvents>(event: K, fn: (e: WorldEvents[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Finds an entity by id, 'Parent/Child' name path or name (first match). Returns null when missing
   * and logs a "did you mean" hint once (unless `quiet`).
   */
  find(ref: string | RuntimeEntity, opts: { quiet?: boolean } = {}): RuntimeEntity | null {
    if (ref && typeof ref === 'object' && (ref as RuntimeEntity).isRuntimeEntity) {
      return (ref as RuntimeEntity).destroyed ? null : (ref as RuntimeEntity);
    }
    if (typeof ref !== 'string' || !ref) return null;
    const byId = this.entities.get(ref);
    if (byId && !byId.destroyed) return byId;
    if (ref.includes('/')) {
      for (const e of this.entities.values()) if (!e.destroyed && this.pathOf(e) === ref) return e;
    }
    for (const e of this.entities.values()) if (!e.destroyed && e.name === ref) return e;
    if (!opts.quiet) {
      const names = [...this.entities.values()].filter((e) => !e.destroyed).map((e) => e.name);
      this.warnOnce(
        `find:${ref}`,
        `find('${ref}') found no entity. ${didYouMean(ref, names) ?? 'Check the name, id or tag.'}`,
      );
    }
    return null;
  }

  /** All live entities matching a tag and/or name (a string is a tag). */
  findAll(query?: FindQuery | string): RuntimeEntity[] {
    const q: FindQuery = typeof query === 'string' ? { tag: query } : (query ?? {});
    const out: RuntimeEntity[] = [];
    for (const e of this.entities.values()) {
      if (e.destroyed) continue;
      if (q.tag && !e.tags.includes(q.tag)) continue;
      if (q.name && e.name !== q.name) continue;
      out.push(e);
    }
    return out;
  }

  /** 'Parent/Child' name path of an entity. */
  pathOf(e: RuntimeEntity): string {
    const parts: string[] = [];
    let cur: RuntimeEntity | null = e;
    let guard = 0;
    while (cur && guard++ < 1000) {
      parts.unshift(cur.name);
      cur = cur._parent;
    }
    return parts.join('/');
  }

  /**
   * Spawns a prefab (path or name, e.g. 'prefabs/coin.prefab.json' or 'coin') or clones an entity
   * (with its children). awake() runs immediately, start() before its first update.
   */
  instantiate(source: string | RuntimeEntity, opts: InstantiateOptions = {}): RuntimeEntity {
    const prev = enterWorld(this);
    try {
      let docs: EntityDoc[];
      let prefabPath: string | undefined;
      if (typeof source === 'string') {
        const prefab = this.resolvePrefab(source);
        if (prefab) {
          docs = cloneJson(prefab.doc.entities) as EntityDoc[];
          prefabPath = prefab.path;
        } else {
          const e = this.find(source, { quiet: true });
          if (!e) {
            const prefabs = Object.keys(this.opts.prefabs ?? {});
            throw new AigeError(
              'NOT_FOUND',
              `Cannot instantiate '${source}': no prefab or entity with that name.`,
              {
                hint:
                  didYouMean(source, [...prefabs, ...[...this.entities.values()].map((x) => x.name)]) ??
                  (prefabs.length ? `Prefabs: ${prefabs.join(', ')}` : 'The project has no prefabs.'),
              },
            );
          }
          docs = this.serializeSubtree(e);
        }
      } else if (source && (source as RuntimeEntity).isRuntimeEntity) {
        docs = this.serializeSubtree(source);
      } else {
        throw new AigeError('INVALID_INPUT', 'instantiate() needs a prefab path or an entity.', {
          hint: "Example: Scene.instantiate('prefabs/coin.prefab.json', { position: [0, 1, 0] })",
        });
      }
      if (docs.length === 0)
        throw new AigeError('INVALID_INPUT', `Prefab '${String(source)}' has no entities.`);
      const idMap = new Map<string, string>();
      for (const d of docs) idMap.set(d.id, this.allocId());
      const parent =
        opts.parent === undefined || opts.parent === null
          ? null
          : typeof opts.parent === 'string'
            ? this.find(opts.parent)
            : opts.parent;
      const mapped: EntityDoc[] = docs.map((d) => ({
        ...d,
        id: idMap.get(d.id)!,
        parent: d.parent && idMap.has(d.parent) ? idMap.get(d.parent)! : (parent?.id ?? null),
      }));
      const rootIndex = docs.findIndex((d) => !d.parent || !idMap.has(d.parent));
      const rootDoc = mapped[Math.max(0, rootIndex)]!;
      if (prefabPath) rootDoc.prefab = prefabPath;
      if (opts.name) rootDoc.name = opts.name;
      for (const d of mapped) this.spawnedIds.add(d.id);
      const list = this.createEntities(mapped);
      const root = this.entities.get(rootDoc.id)!;
      if (opts.position !== undefined) root.worldPosition = opts.position;
      if (opts.rotation !== undefined) root.worldQuaternion = opts.rotation;
      const created = this.finishEntities(list);
      // Awake immediately (Unity-like), start before the first update.
      for (const r of created) {
        if (!r.awoken && !r.dead && this.runnable(r)) {
          r.awoken = true;
          this.callHook(r, 'awake');
        }
      }
      for (const e of list) {
        this.changes.spawned.push(e);
        this.emit('spawned', e);
      }
      return root;
    } finally {
      exitWorld(prev);
    }
  }

  /** Destroys an entity (and its children) at the end of the frame, or after `delay` seconds. */
  destroy(target: RuntimeEntity | string | null | undefined, delay = 0): void {
    const e = typeof target === 'string' ? this.find(target) : target;
    if (!e?.isRuntimeEntity || e.destroyed) return;
    if (delay > 0) {
      this.delayed.push({ entity: e, at: this.time + delay });
      return;
    }
    e._pendingDestroy = true;
    this.destroyQueue.push(e);
  }

  /** Moves an entity back to its spawn pose and stops its motion. */
  respawn(e: RuntimeEntity): void {
    this.physics.teleport(e, e._spawnPosition.clone(), e._spawnQuaternion.clone());
    e._fallen = false;
  }

  /** The primary Camera entity (or any camera), or null. */
  primaryCamera(): RuntimeEntity | null {
    let fallback: RuntimeEntity | null = null;
    for (const e of this.entities.values()) {
      if (e.destroyed) continue;
      const cam = e.components.find((c) => c.type === 'Camera');
      if (!cam || !e.activeInHierarchy) continue;
      if (cam.primary !== false) return e;
      fallback ??= e;
    }
    return fallback;
  }

  /** Loads another scene by name or path at the end of the frame. Game.state is kept. */
  loadScene(ref: string): void {
    const found = this.resolveScene(ref);
    if (!found) {
      const known = [...Object.keys(this.opts.scenes ?? {}), ...(this.initialPath ? [this.initialPath] : [])];
      throw new AigeError('NOT_FOUND', `Scene '${ref}' not found.`, {
        hint: didYouMean(ref, known) ?? `Scenes: ${known.join(', ') || '(none were passed to World.create)'}`,
      });
    }
    this.pendingLoad = { doc: found.doc, path: found.path, restart: false };
  }

  /** Reloads the starting scene and clears Game.state and game over (at the end of the frame). */
  restart(): void {
    this.pendingLoad = { doc: this.initialScene, path: this.initialPath, restart: true };
  }

  /** The current state as a SceneDoc (spawned entities included, destroyed ones removed). */
  snapshotScene(): SceneDoc {
    const entities: Entity[] = [];
    for (const e of this.entities.values()) if (!e.destroyed) entities.push(this.toEntityDoc(e));
    return {
      format: 'aige.scene',
      version: 1,
      name: this.sceneDoc.name,
      nextId: this.nextId,
      settings: cloneJson(this.sceneDoc.settings),
      entities,
    };
  }

  /** Hash of rounded transforms, active flags, Game.state and game over. Equal runs give equal hashes. */
  stateHash(): string {
    const f = (n: number, d: number) => round(n, d).toFixed(d);
    const parts: string[] = [];
    const ids = [...this.entities.keys()].filter((id) => !this.entities.get(id)!.destroyed).sort();
    for (const id of ids) {
      const o = this.entities.get(id)!.object3d;
      const q = o.quaternion;
      const s = q.w < 0 ? -1 : 1;
      parts.push(
        `${id}|${this.entities.get(id)!.active ? 1 : 0}|${f(o.position.x, 3)},${f(o.position.y, 3)},${f(o.position.z, 3)}|${f(q.x * s, 4)},${f(q.y * s, 4)},${f(q.z * s, 4)},${f(q.w * s, 4)}|${f(o.scale.x, 3)},${f(o.scale.y, 3)},${f(o.scale.z, 3)}`,
      );
    }
    parts.push(stableStringify(toPlain(this.gameState)));
    parts.push(JSON.stringify(this.gameOver));
    return hashString(parts.join('\n'));
  }

  /** What changed since the last call (spawned/destroyed entities, mutated components, active flags). */
  drainChanges(): WorldChanges {
    const out = this.changes;
    out.components = [...this.dirtyComponents];
    out.active = [...this.activeChanged];
    this.dirtyComponents.clear();
    this.activeChanged.clear();
    this.changes = { spawned: [], destroyed: [], components: [], active: [], sceneLoaded: false };
    return out;
  }

  /** Frees the physics world and backends. The world cannot be used afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.physics.dispose();
    this.input.source.dispose?.();
    this.audio.dispose?.();
    this.listeners.clear();
    this.gameListeners = [];
  }

  // -------------------------------------------------------------------------------------------
  // Game, HUD, audio, logging (used by the scripting singletons)
  // -------------------------------------------------------------------------------------------

  emitGame(name: string, data?: unknown): void {
    const ev: GameEvent = { t: round(this.time, 4), name: String(name), data: toPlain(data) ?? null };
    this.emit('game', ev);
    for (const l of [...this.gameListeners]) {
      if (l.name !== name && l.name !== '*') continue;
      if (l.owner) {
        if (l.owner.dead || l.owner.entity._destroyed) continue;
        this.invoke(l.owner, `Game.on('${l.name}')`, l.fn, data, name);
      } else {
        try {
          l.fn(data, name);
        } catch (err) {
          this.reportEngineError(err, `Game.on('${l.name}') listener`);
        }
      }
    }
  }

  onGame(name: string, fn: (data: any, name: string) => void): () => void {
    const l: GameListener = { name: String(name), fn, owner: this.currentRecord };
    this.gameListeners.push(l);
    return () => {
      this.gameListeners = this.gameListeners.filter((x) => x !== l);
    };
  }

  win(message?: string): void {
    this.finish('win', message ?? 'You win!');
  }

  lose(message?: string): void {
    this.finish('lose', message ?? 'Game over');
  }

  private finish(result: 'win' | 'lose', message: string): void {
    if (this.gameOver) return;
    this.gameOver = { result, message: String(message) };
    this.log('info', [`Game over (${result}): ${message}`]);
    this.emitGame(result, { message: String(message) });
  }

  /** HUD key of an entity's UIText (its `id`, else the entity name), or null. */
  hudKeyOf(e: RuntimeEntity): string | null {
    const c = e.components.find((x) => x.type === 'UIText');
    if (!c) return null;
    return typeof c.id === 'string' && c.id ? c.id : e.name;
  }

  setHudText(id: string, text: unknown, opts?: Partial<HudEntry>): void {
    const key = String(id);
    let h = this.hud[key];
    if (!h) {
      h = { text: '', anchor: 'top-left', offset: [16, 16], fontSize: 24, color: '#ffffff', visible: true };
      this.hud[key] = h;
    }
    h.text = typeof text === 'string' ? text : formatArg(text);
    const link = this.hudLinks.get(key);
    if (opts) {
      if (opts.anchor && ANCHORS.includes(opts.anchor)) h.anchor = opts.anchor;
      if (Array.isArray(opts.offset)) h.offset = [numOr(opts.offset[0], 16), numOr(opts.offset[1], 16)];
      if (typeof opts.fontSize === 'number') h.fontSize = opts.fontSize;
      if (typeof opts.color === 'string') h.color = opts.color;
      if (typeof opts.visible === 'boolean') {
        h.visible = opts.visible;
        if (link) link.shown = opts.visible;
      }
      if (link) {
        link.comp.anchor = h.anchor;
        link.comp.offset = [...h.offset];
        link.comp.fontSize = h.fontSize;
        link.comp.color = h.color;
      }
    }
    if (link) {
      link.comp.text = h.text;
      link.lastText = h.text;
    }
  }

  showHud(id: string, visible: boolean): void {
    const key = String(id);
    const h = this.hud[key];
    if (!h) {
      this.warnOnce(
        `hud:${key}`,
        `UI.show('${key}'): no HUD element with that id. HUD ids: ${Object.keys(this.hud).join(', ') || '(none)'}.`,
      );
      return;
    }
    const link = this.hudLinks.get(key);
    if (link) {
      link.shown = !!visible;
      h.visible = link.shown && link.entity.activeInHierarchy;
    } else h.visible = !!visible;
  }

  playSfx(preset: SfxPreset | string, opts: PlayOptions = {}): void {
    let p = preset as SfxPreset;
    if (!isSfxPreset(p)) {
      this.warnOnce(
        `sfx:${String(preset)}`,
        `Unknown sfx preset '${String(preset)}'. ${didYouMean(String(preset), SFX_PRESETS) ?? ''} Presets: ${SFX_PRESETS.join(', ')}.`,
      );
      p = 'click';
    }
    try {
      this.audio.sfx(p, opts);
    } catch (err) {
      this.reportEngineError(err, 'audio');
    }
    this.emit('audio', { t: round(this.time, 4), kind: 'sfx', name: p, opts: { ...opts } });
  }

  playClip(clip: string, opts: PlayOptions = {}): void {
    try {
      this.audio.play(String(clip), opts);
    } catch (err) {
      this.reportEngineError(err, 'audio');
    }
    this.emit('audio', { t: round(this.time, 4), kind: 'play', name: String(clip), opts: { ...opts } });
  }

  stopAudio(): void {
    try {
      this.audio.stopAll();
    } catch (err) {
      this.reportEngineError(err, 'audio');
    }
    this.emit('audio', { t: round(this.time, 4), kind: 'stop', name: '*', opts: {} });
  }

  /** Logs a message, attributed to the behaviour that is currently running (if any). */
  log(level: 'info' | 'warn', args: unknown[], rec?: BehaviourRecord | null): void {
    const r = rec === undefined ? this.currentRecord : rec;
    this.emit('log', {
      t: round(this.time, 3),
      level,
      message: args.map(formatArg).join(' '),
      script: r?.script ?? null,
      entity: r?.entity.name ?? null,
    });
  }

  /** Logs on behalf of a behaviour (Behaviour.log). */
  logFrom(b: Behaviour, level: 'info' | 'warn', args: unknown[]): void {
    this.log(level, args, this.recordOf.get(b) ?? null);
  }

  /** Logs a warning once per key. */
  warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log('warn', [message]);
  }

  // -------------------------------------------------------------------------------------------
  // Internal hooks used by RuntimeEntity
  // -------------------------------------------------------------------------------------------

  /** @internal */
  _onActiveChanged(e: RuntimeEntity): void {
    this.activeChanged.add(e.id);
    const visit = (x: RuntimeEntity) => {
      this.physics.setEnabled(x, x.activeInHierarchy);
      for (const c of x._children) visit(c);
    };
    visit(e);
    for (const [key, link] of this.hudLinks) {
      const h = this.hud[key];
      if (h) h.visible = link.shown && link.entity.activeInHierarchy;
    }
  }

  /** @internal */
  _markComponentDirty(e: RuntimeEntity, _comp: ComponentData): void {
    this.dirtyComponents.add(e.id);
  }

  /** @internal */
  _reparent(e: RuntimeEntity, parent: RuntimeEntity | string | null, keepWorld: boolean): void {
    const p = typeof parent === 'string' ? this.find(parent) : parent;
    for (let cur = p; cur; cur = cur._parent) {
      if (cur === e) {
        throw new AigeError('INVALID_INPUT', `Cannot parent '${e.name}' to itself or one of its children.`);
      }
    }
    if (e._parent) e._parent._children = e._parent._children.filter((c) => c !== e);
    e._parent = p ?? null;
    if (p) p._children.push(e);
    const target = p?.object3d ?? this.root;
    if (keepWorld) target.attach(e.object3d);
    else target.add(e.object3d);
  }

  /** @internal */
  _addScript(
    e: RuntimeEntity,
    cls: string | BehaviourClass,
    props: Record<string, unknown>,
  ): Behaviour | null {
    let klass: BehaviourClass;
    let path: string;
    if (typeof cls === 'string') {
      const r = this.resolveScript(cls);
      if (!r) {
        throw new AigeError('NOT_FOUND', `Script '${cls}' not found.`, { hint: this.scriptHint(cls) });
      }
      klass = r.cls;
      path = r.path;
    } else if (typeof cls === 'function') {
      klass = cls;
      path = this.pathOfClass(cls) ?? `class:${cls.name || 'Anonymous'}`;
    } else {
      throw new AigeError('INVALID_INPUT', 'addScript() needs a Behaviour class or a script path.');
    }
    const prev = enterWorld(this);
    try {
      const rec = this.createBehaviourFromClass(e, klass, path, props ?? {}, true);
      if (!rec) return null;
      if (!path.startsWith('class:')) {
        e.components.push({ type: 'Script', script: path, props: cloneJson(props ?? {}), enabled: true });
      }
      if (this.runnable(rec)) {
        rec.awoken = true;
        this.callHook(rec, 'awake');
      }
      return rec.inst;
    } finally {
      exitWorld(prev);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------------------------

  private runFrame(realDt: number, updateDt: number, steps: () => void): void {
    const prev = enterWorld(this);
    try {
      this.input.beginFrame(this.realTime, this.frame);
      this.flushStarts();
      steps();
      this.phase = 'update';
      this.physics.beginUpdatePhase();
      this.dt = updateDt;
      this.flushStarts();
      this.runPhase('update', updateDt);
      this.phase = 'late';
      this.flushStarts();
      this.runPhase('lateUpdate', updateDt);
      this.phase = 'idle';
      this.endFrame();
    } catch (err) {
      this.reportEngineError(err, 'frame');
    } finally {
      this.phase = 'idle';
      this.frame++;
      this.realTime += realDt;
      exitWorld(prev);
    }
  }

  private fixedStep(): void {
    this.phase = 'fixed';
    this.dt = this.fixedDt;
    this.flushStarts();
    this.runPhase('fixedUpdate', this.fixedDt);
    this.phase = 'physics';
    this.root.updateMatrixWorld(true);
    this.physics.preStep(this.fixedDt);
    const events = this.physics.step();
    this.physics.postStep();
    this.time += this.fixedDt;
    this.phase = 'events';
    this.dispatchContacts(events);
    this.checkKillY();
    this.phase = 'fixed';
  }

  private runPhase(hook: 'fixedUpdate' | 'update' | 'lateUpdate', dt: number): void {
    const list = this.records;
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const r = list[i]!;
      if (!r.started || r.dead) continue;
      const fn = (r.inst as any)[hook];
      if (typeof fn !== 'function' || !this.runnable(r)) continue;
      this.invoke(r, hook, fn, dt);
    }
  }

  private runnable(r: BehaviourRecord, ignorePending = false): boolean {
    const e = r.entity;
    if (e._destroyed || (!ignorePending && e._pendingDestroy)) return false;
    return r.inst.enabled !== false && e.activeInHierarchy;
  }

  private callHook(r: BehaviourRecord, hook: string, ...args: unknown[]): void {
    const fn = (r.inst as any)[hook];
    if (typeof fn === 'function') this.invoke(r, hook, fn, ...args);
  }

  private invoke(r: BehaviourRecord, hook: string, fn: (...a: any[]) => any, ...args: unknown[]): void {
    const prev = this.currentRecord;
    this.currentRecord = r;
    try {
      const res = fn.apply(r.inst, args);
      if (res && typeof res.then === 'function') {
        res.then(undefined, (err: unknown) => this.reportError(err, r, hook));
      }
    } catch (err) {
      this.reportError(err, r, hook);
    } finally {
      this.currentRecord = prev;
    }
  }

  /** awake() for new behaviours of active entities, then start() for those not started yet. */
  private flushStarts(): void {
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i]!;
      if (!r.awoken && !r.dead && this.runnable(r)) {
        r.awoken = true;
        this.callHook(r, 'awake');
      }
    }
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i]!;
      if (r.awoken && !r.started && !r.dead && this.runnable(r)) {
        r.started = true;
        this.callHook(r, 'start');
      }
    }
    if (this.pendingAudio.length) {
      const list = this.pendingAudio;
      this.pendingAudio = [];
      for (const { entity, comp } of list) {
        if (entity.destroyed || !entity.activeInHierarchy) continue;
        const opts: PlayOptions = { volume: numOr(comp.volume, 0.8), loop: !!comp.loop };
        if (typeof comp.sfx === 'string') this.playSfx(comp.sfx, opts);
        else if (typeof comp.clip === 'string') this.playClip(comp.clip, opts);
      }
    }
  }

  private dispatchContacts(events: ContactEvent[]): void {
    for (const ev of events) {
      if (ev.a._destroyed || ev.b._destroyed) continue;
      if (ev.enter && (ev.a._pendingDestroy || ev.b._pendingDestroy)) continue;
      const hook =
        ev.kind === 'trigger'
          ? ev.enter
            ? 'onTriggerEnter'
            : 'onTriggerExit'
          : ev.enter
            ? 'onCollisionEnter'
            : 'onCollisionExit';
      const infoA = ev.info;
      const infoB: CollisionInfo | null = ev.info
        ? {
            normal: ev.info.normal.clone().negate(),
            point: ev.info.point?.clone() ?? null,
            relativeSpeed: ev.info.relativeSpeed,
          }
        : null;
      this.sendContact(ev.a, ev.aBody, hook, ev.b, infoA);
      this.sendContact(ev.b, ev.bBody, hook, ev.a, infoB);
    }
  }

  private sendContact(
    self: RuntimeEntity,
    body: RuntimeEntity,
    hook: string,
    other: RuntimeEntity,
    info: CollisionInfo | null,
  ): void {
    const targets = body !== self ? [self, body] : [self];
    for (const t of targets) {
      for (const inst of [...t._behaviours]) {
        const r = this.recordOf.get(inst);
        if (!r?.awoken || r.dead || !this.runnable(r, true)) continue;
        const fn = (inst as any)[hook];
        if (typeof fn !== 'function') continue;
        if (info) this.invoke(r, hook, fn, other, info);
        else this.invoke(r, hook, fn, other);
      }
    }
  }

  private checkKillY(): void {
    const killY = numOr(this.sceneDoc.settings?.killY, -50);
    const fallen: RuntimeEntity[] = [];
    this.physics.forEachMoving((e, y) => {
      if (e.destroyed) return;
      if (y < killY) {
        if (!e._fallen) {
          e._fallen = true;
          fallen.push(e);
        }
      } else e._fallen = false;
    });
    for (const e of fallen) {
      const handlers = e._behaviours
        .map((b) => this.recordOf.get(b))
        .filter((r): r is BehaviourRecord => !!r && typeof (r.inst as any).onFall === 'function');
      const usable = handlers.filter((r) => r.awoken && !r.dead && this.runnable(r));
      if (usable.length > 0) {
        for (const r of usable) this.callHook(r, 'onFall');
      } else if (e.character) {
        // Characters are usually the player: bring them back instead of losing them.
        this.warnOnce(
          `fall-respawn:${e.id}`,
          `'${e.name}' fell below killY (${killY}) and was respawned. Give it an onFall() handler to change this.`,
        );
        this.respawn(e);
      } else {
        this.log(
          'warn',
          [
            `'${e.name}' fell below killY (${killY}) and was destroyed. Give it an onFall() handler to change this.`,
          ],
          null,
        );
        this.destroy(e);
      }
    }
  }

  private endFrame(): void {
    this.processDestroys();
    this.syncHud();
    if (this.pendingLoad) this.performLoad();
  }

  private processDestroys(): void {
    if (this.delayed.length) {
      const due = this.delayed.filter((d) => d.at <= this.time + 1e-9);
      if (due.length) {
        this.delayed = this.delayed.filter((d) => d.at > this.time + 1e-9);
        for (const d of due) this.destroy(d.entity);
      }
    }
    let guard = 0;
    let removedAny = false;
    while (this.destroyQueue.length && guard++ < 100) {
      const queue = this.destroyQueue;
      this.destroyQueue = [];
      const all: RuntimeEntity[] = [];
      const seen = new Set<RuntimeEntity>();
      const collect = (e: RuntimeEntity) => {
        if (seen.has(e) || e._destroyed) return;
        seen.add(e);
        e._pendingDestroy = true;
        all.push(e);
        for (const c of e._children) collect(c);
      };
      for (const e of queue) collect(e);
      for (const e of all) {
        for (const inst of [...e._behaviours]) {
          const r = this.recordOf.get(inst);
          if (r?.awoken && !r.dead) this.callHook(r, 'onDestroy');
        }
      }
      for (const e of all) this.removeEntityNow(e);
      removedAny ||= all.length > 0;
    }
    if (removedAny) {
      this.records = this.records.filter((r) => {
        if (!r.entity._destroyed) return true;
        this.recordOf.delete(r.inst);
        return false;
      });
      this.gameListeners = this.gameListeners.filter((l) => !l.owner?.entity._destroyed);
    }
  }

  private removeEntityNow(e: RuntimeEntity): void {
    try {
      this.physics.removeEntity(e);
    } catch (err) {
      this.reportEngineError(err, `removing '${e.name}' from physics`);
    }
    for (const [key, link] of this.hudLinks) {
      if (link.entity === e) {
        this.hudLinks.delete(key);
        delete this.hud[key];
      }
    }
    e.object3d.removeFromParent();
    if (e._parent && !e._parent._pendingDestroy)
      e._parent._children = e._parent._children.filter((c) => c !== e);
    this.entities.delete(e.id);
    e._destroyed = true;
    this.changes.destroyed.push(e.id);
    this.emit('destroyed', e);
  }

  private syncHud(): void {
    for (const [key, link] of this.hudLinks) {
      const h = this.hud[key];
      if (!h) continue;
      const c = link.comp;
      const text = String(c.text ?? '');
      if (text !== link.lastText) {
        h.text = text;
        link.lastText = text;
      }
      if (typeof c.anchor === 'string' && ANCHORS.includes(c.anchor as UIAnchor))
        h.anchor = c.anchor as UIAnchor;
      if (Array.isArray(c.offset)) h.offset = [numOr(c.offset[0], 16), numOr(c.offset[1], 16)];
      if (typeof c.fontSize === 'number') h.fontSize = c.fontSize;
      if (typeof c.color === 'string') h.color = c.color;
    }
  }

  private performLoad(): void {
    const load = this.pendingLoad!;
    this.pendingLoad = null;
    for (const r of this.records)
      if (r.awoken && !r.dead && !r.entity._destroyed) this.callHook(r, 'onDestroy');
    for (const e of this.entities.values()) {
      e._destroyed = true;
      e.object3d.removeFromParent();
    }
    this.physics.dispose();
    this.physics = this.newPhysics();
    this.entities.clear();
    this.records = [];
    this.recordOf = new Map();
    for (const k of Object.keys(this.hud)) delete this.hud[k];
    this.hudLinks.clear();
    this.gameListeners = this.gameListeners.filter((l) => !l.owner);
    this.delayed = [];
    this.destroyQueue = [];
    this.pendingAudio = [];
    this.spawnedIds.clear();
    this.gameOver = null;
    if (load.restart) for (const k of Object.keys(this.gameState)) delete this.gameState[k];
    this.sceneDoc = load.doc;
    this.scenePath = load.path;
    this.usingInitialModels = load.doc === this.initialScene;
    this.changes = { spawned: [], destroyed: [], components: [], active: [], sceneLoaded: true };
    this.buildScene(load.doc);
    this.emit('sceneLoad', {
      t: round(this.time, 4),
      name: load.doc.name,
      path: load.path,
      restart: load.restart,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Building entities
  // -------------------------------------------------------------------------------------------

  private buildScene(doc: SceneDoc): void {
    let maxId = 0;
    for (const e of doc.entities) {
      const m = /^e(\d+)$/.exec(e.id);
      if (m) maxId = Math.max(maxId, Number(m[1]));
    }
    this.nextId = Math.max(numOr(doc.nextId, 1), maxId + 1);
    const list = this.createEntities(doc.entities as EntityDoc[]);
    this.finishEntities(list);
    this.flushStarts();
  }

  private allocId(): string {
    let id = `e${this.nextId++}`;
    while (this.entities.has(id)) id = `e${this.nextId++}`;
    return id;
  }

  /** Creates RuntimeEntities (transforms + hierarchy, no physics or scripts yet). */
  private createEntities(docs: EntityDoc[]): RuntimeEntity[] {
    const list: RuntimeEntity[] = [];
    for (const d of docs) {
      if (!d || typeof d.id !== 'string') continue;
      if (this.entities.has(d.id)) {
        this.warnOnce(
          `dup-id:${d.id}`,
          `Duplicate entity id '${d.id}' in the scene; the second one is skipped.`,
        );
        continue;
      }
      const comps = (Array.isArray(d.components) ? d.components : [])
        .filter(
          (c): c is ComponentData => !!c && typeof c === 'object' && typeof (c as any).type === 'string',
        )
        .map((c) => cloneJson(c));
      const e = new RuntimeEntity(this, {
        id: d.id,
        name: String(d.name ?? d.id),
        tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
        active: d.active !== false,
        components: comps,
        prefab: d.prefab,
      });
      const t = d.transform;
      const p = vec3Or(t?.position, [0, 0, 0]);
      const r = vec3Or(t?.rotation, [0, 0, 0]);
      const s = vec3Or(t?.scale, [1, 1, 1]);
      e.object3d.position.set(p[0], p[1], p[2]);
      e.object3d.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ');
      e.object3d.scale.set(s[0], s[1], s[2]);
      this.entities.set(e.id, e);
      list.push(e);
    }
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      const pid = docs.find((d) => d?.id === e.id)?.parent ?? null;
      let parent = pid ? (this.entities.get(pid) ?? null) : null;
      if (pid && !parent) {
        this.warnOnce(
          `missing-parent:${e.id}`,
          `'${e.name}' has parent '${pid}', which does not exist; placed at the root.`,
        );
      }
      for (let cur = parent; cur; cur = cur._parent) {
        if (cur === e) {
          this.warnOnce(`cycle:${e.id}`, `'${e.name}' is part of a parent cycle; placed at the root.`);
          parent = null;
          break;
        }
      }
      e._parent = parent;
      if (parent) parent._children.push(e);
      (parent?.object3d ?? this.root).add(e.object3d);
    }
    return list;
  }

  /** Adds physics, HUD and behaviours for freshly created entities. Returns the new behaviour records. */
  private finishEntities(list: RuntimeEntity[]): BehaviourRecord[] {
    this.root.updateMatrixWorld(true);
    for (const e of list) {
      e.object3d.getWorldPosition(e._spawnPosition);
      e.object3d.getWorldQuaternion(e._spawnQuaternion);
    }
    const depth = (e: RuntimeEntity) => {
      let d = 0;
      for (let p = e._parent; p; p = p._parent) d++;
      return d;
    };
    const ordered = list.map((e, i) => ({ e, i, d: depth(e) })).sort((a, b) => a.d - b.d || a.i - b.i);
    for (const { e } of ordered) {
      try {
        this.physics.addEntity(e);
      } catch (err) {
        this.reportEngineError(err, `creating physics for '${e.name}'`);
      }
    }
    for (const e of list) this.registerHud(e);
    const created: BehaviourRecord[] = [];
    for (const e of list) {
      for (const c of e.components) {
        if (c.type === 'Script') {
          const props = c.props && typeof c.props === 'object' ? (c.props as Record<string, unknown>) : {};
          const r = this.createBehaviour(e, String(c.script ?? ''), props, c.enabled !== false);
          if (r) created.push(r);
        } else if (c.type === 'AudioSource' && c.playOnStart) {
          this.pendingAudio.push({ entity: e, comp: c });
        }
      }
    }
    return created;
  }

  private registerHud(e: RuntimeEntity): void {
    const c = e.components.find((x) => x.type === 'UIText');
    if (!c) return;
    const key = this.hudKeyOf(e)!;
    const text = String(c.text ?? '');
    this.hud[key] = {
      text,
      anchor: ANCHORS.includes(c.anchor as UIAnchor) ? (c.anchor as UIAnchor) : 'top-left',
      offset: Array.isArray(c.offset) ? [numOr(c.offset[0], 16), numOr(c.offset[1], 16)] : [16, 16],
      fontSize: numOr(c.fontSize, 24),
      color: typeof c.color === 'string' ? c.color : '#ffffff',
      visible: e.activeInHierarchy,
    };
    this.hudLinks.set(key, { entity: e, comp: c, lastText: text, shown: true });
  }

  private createBehaviour(
    e: RuntimeEntity,
    ref: string,
    props: Record<string, unknown>,
    enabled: boolean,
  ): BehaviourRecord | null {
    const resolved = this.resolveScript(ref);
    if (!resolved) {
      this.reportLoadError(e, ref, `Script '${ref}' on '${e.name}' was not found. ${this.scriptHint(ref)}`);
      return null;
    }
    return this.createBehaviourFromClass(e, resolved.cls, resolved.path, props, enabled);
  }

  private createBehaviourFromClass(
    e: RuntimeEntity,
    cls: BehaviourClass,
    path: string,
    props: Record<string, unknown>,
    enabled: boolean,
  ): BehaviourRecord | null {
    const staticProps = cls.props && typeof cls.props === 'object' ? cloneProps(cls.props) : {};
    const overrides = cloneProps(props ?? {});
    const merged: Record<string, any> = { ...staticProps, ...overrides };
    let inst: Behaviour;
    const prevRecord = this.currentRecord;
    try {
      inst = constructBehaviour(cls, { entity: e, world: this, props: merged, overrides, script: path });
    } catch (err) {
      const f = this.opts.formatError?.(err, path) ?? defaultFormatError(err);
      this.emit('error', {
        message: `Could not create ${path}: ${f.message}`,
        script: path,
        entity: e.name,
        entityId: e.id,
        hook: 'constructor',
        stack: f.stack ?? '',
        t: round(this.time, 4),
      });
      return null;
    } finally {
      this.currentRecord = prevRecord;
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (RESERVED_FIELDS.has(k)) continue;
      if (Object.hasOwn(inst, k) && typeof (inst as any)[k] !== 'function') (inst as any)[k] = v;
    }
    if (!enabled) inst.enabled = false;
    const rec: BehaviourRecord = {
      inst,
      entity: e,
      script: path,
      awoken: false,
      started: false,
      dead: false,
      errors: 0,
    };
    this.records.push(rec);
    this.recordOf.set(inst, rec);
    e._behaviours.push(inst);
    return rec;
  }

  private normalizeClass(v: unknown): BehaviourClass | null {
    if (typeof v === 'function') return v as BehaviourClass;
    if (v && typeof v === 'object' && typeof (v as any).default === 'function') return (v as any).default;
    return null;
  }

  private resolveScript(ref: string): { cls: BehaviourClass; path: string } | null {
    const r = String(ref ?? '')
      .trim()
      .replaceAll('\\', '/')
      .replace(/^\.\//, '');
    if (!r) return null;
    const builtin = (name: string) => {
      if (builtinBehaviours[name]) return { cls: builtinBehaviours[name]!, path: `builtin:${name}` };
      const key = Object.keys(builtinBehaviours).find((k) => k.toLowerCase() === name.toLowerCase());
      return key ? { cls: builtinBehaviours[key]!, path: `builtin:${key}` } : null;
    };
    if (r.startsWith('builtin:')) return builtin(r.slice('builtin:'.length));
    const scripts = this.opts.scripts ?? {};
    const candidates = [r, `${r}.ts`, r.replace(/\.(js|mjs|tsx)$/, '.ts'), `scripts/${r}`, `scripts/${r}.ts`];
    for (const c of candidates) {
      if (c in scripts) {
        const cls = this.normalizeClass(scripts[c]);
        if (cls) return { cls, path: c };
        this.warnOnce(
          `bad-script:${c}`,
          `${c} must default-export a class extending Behaviour: export default class X extends Behaviour { ... }`,
        );
        return null;
      }
    }
    const b = builtin(r);
    if (b) return b;
    const lower = r.toLowerCase();
    const base = (p: string) =>
      p
        .toLowerCase()
        .replace(/^.*\//, '')
        .replace(/\.(ts|js)$/, '');
    const key = Object.keys(scripts).find((k) => k.toLowerCase() === lower || base(k) === base(r));
    if (key) {
      const cls = this.normalizeClass(scripts[key]);
      if (cls) return { cls, path: key };
    }
    return null;
  }

  private scriptHint(ref: string): string {
    const all = [
      ...Object.keys(this.opts.scripts ?? {}),
      ...Object.keys(builtinBehaviours).map((b) => `builtin:${b}`),
    ];
    return didYouMean(ref, all) ?? `Available: ${all.join(', ')}.`;
  }

  private pathOfClass(cls: BehaviourClass): string | null {
    for (const [k, v] of Object.entries(this.opts.scripts ?? {}))
      if (this.normalizeClass(v) === cls) return k;
    for (const [k, v] of Object.entries(builtinBehaviours)) if (v === cls) return `builtin:${k}`;
    return null;
  }

  private resolvePrefab(ref: string): { path: string; doc: PrefabDoc } | null {
    const prefabs = this.opts.prefabs ?? {};
    const r = ref.trim().replaceAll('\\', '/').replace(/^\.\//, '');
    for (const c of [r, `prefabs/${r}`, `${r}.prefab.json`, `prefabs/${r}.prefab.json`]) {
      const doc = prefabs[c];
      if (doc) return { path: c, doc };
    }
    for (const [path, doc] of Object.entries(prefabs)) {
      if (
        doc?.name === r ||
        path
          .toLowerCase()
          .replace(/^.*\//, '')
          .replace(/\.prefab\.json$/, '') === r.toLowerCase()
      )
        return { path, doc };
    }
    return null;
  }

  private resolveScene(ref: string): { path: string | null; doc: SceneDoc } | null {
    const all: [string | null, SceneDoc][] = Object.entries(this.opts.scenes ?? {});
    if (!all.some(([, d]) => d === this.initialScene)) all.push([this.initialPath, this.initialScene]);
    const r = String(ref).trim().replaceAll('\\', '/');
    for (const [path, doc] of all) {
      if (path === r || path === `scenes/${r}.scene.json` || doc.name === r) return { path, doc };
      if (path && path.replace(/^.*\//, '').replace(/\.scene\.json$/, '') === r) return { path, doc };
    }
    return null;
  }

  private modelInfo(e: RuntimeEntity): ModelInfo | undefined {
    if (this.usingInitialModels && !this.spawnedIds.has(e.id)) {
      const m = this.opts.models?.[e.id];
      if (m) return m;
    }
    const mr = e.components.find((c) => c.type === 'MeshRenderer');
    if (mr && typeof mr.model === 'string' && this.opts.modelInfoForPath) {
      try {
        return this.opts.modelInfoForPath(mr.model);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private serializeSubtree(root: RuntimeEntity): EntityDoc[] {
    const out: EntityDoc[] = [];
    const visit = (e: RuntimeEntity, isRoot: boolean) => {
      if (e.destroyed) return;
      const d = this.toEntityDoc(e);
      if (isRoot) {
        // world transform for the clone root (it is re-parented by instantiate)
        const q = e.worldQuaternion;
        d.transform = {
          position: roundV(e.worldPosition),
          rotation: quatToEulerDeg(q).map((n) => round(n, 4)) as [number, number, number],
          scale: roundV(e.worldScale),
        };
      }
      out.push(d);
      for (const c of e._children) visit(c, false);
    };
    visit(root, true);
    return out;
  }

  /** An entity's current state as a scene Entity (local transform), e.g. to build visuals for a spawned entity. */
  toEntityDoc(e: RuntimeEntity): Entity {
    const o = e.object3d;
    const doc: Entity = {
      id: e.id,
      name: e.name,
      parent: e._parent?.id ?? null,
      active: e.active,
      tags: [...e.tags],
      transform: {
        position: roundV(o.position),
        rotation: quatToEulerDeg(o.quaternion).map((n) => round(n, 4)) as [number, number, number],
        scale: roundV(o.scale),
      },
      components: e.components.map((c) => cloneJson(c)),
    };
    if (e.prefab) doc.prefab = e.prefab;
    return doc;
  }

  // -------------------------------------------------------------------------------------------
  // Events & errors
  // -------------------------------------------------------------------------------------------

  private emit<K extends keyof WorldEvents>(event: K, payload: WorldEvents[K]): void {
    if (this.booting) {
      if (event === 'log' && this.startup.logs.length < 500) this.startup.logs.push(payload as LogEntry);
      if (event === 'error' && this.startup.errors.length < 500)
        this.startup.errors.push(payload as ScriptError);
    }
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch {
        // host listeners must not break the game loop
      }
    }
  }

  private reportError(err: unknown, r: BehaviourRecord, hook: string): void {
    const f = this.opts.formatError?.(err, r.script) ?? defaultFormatError(err);
    r.errors++;
    this.emit('error', {
      message: f.message,
      script: r.script,
      entity: r.entity.name,
      entityId: r.entity.id,
      hook,
      stack: f.stack ?? '',
      t: round(this.time, 4),
    });
    if (r.errors >= this.maxErrors && !r.dead) {
      r.dead = true;
      this.log(
        'warn',
        [`${r.script} on '${r.entity.name}' was disabled after ${r.errors} errors. Last error: ${f.message}`],
        r,
      );
    }
  }

  private reportLoadError(e: RuntimeEntity, script: string, message: string): void {
    this.emit('error', {
      message,
      script,
      entity: e.name,
      entityId: e.id,
      hook: 'load',
      stack: '',
      t: round(this.time, 4),
    });
  }

  private reportEngineError(err: unknown, where: string): void {
    const f = defaultFormatError(err);
    this.emit('error', {
      message: `Engine error while ${where}: ${f.message}`,
      script: 'engine',
      entity: null,
      entityId: null,
      hook: where,
      stack: f.stack ?? '',
      t: round(this.time, 4),
    });
  }
}
