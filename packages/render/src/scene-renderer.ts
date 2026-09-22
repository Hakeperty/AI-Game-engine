import type { ComponentData, Entity, MaterialDoc, ProjectDoc, SceneDoc } from '@aige/core';
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  type Material,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  NoToneMapping,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  PointLight,
  Scene,
  SpotLight,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { type ModelCache, primitiveGeometry, TextureCache } from './assets.ts';

export interface SceneBuildOptions {
  /** Entity id -> model cache key for MeshRenderers that use `model`. */
  meshKeys: Record<string, string>;
  materials: Record<string, MaterialDoc>;
  project?: Pick<ProjectDoc, 'render'>;
  /** Neutral studio look for model previews (ignores scene sky/fog). */
  studio?: boolean;
}

/** Point/spot light intensities are scaled so that `intensity: 1` lights a few meters around the light. */
const POINT_INTENSITY_SCALE = 20;

/**
 * Builds a three.js scene from an AIGE scene document. Used by the editor viewport, the headless
 * renderer and the game player, so all three look identical.
 */
export class SceneRenderer {
  readonly scene = new Scene();
  readonly objects = new Map<string, Object3D>();
  private readonly renderer: WebGLRenderer;
  private readonly models: ModelCache;
  private envCache = new Map<string, import('three').Texture>();
  private readonly materialCache = new Map<string, MeshStandardMaterial>();

  constructor(renderer: WebGLRenderer, models: ModelCache) {
    this.renderer = renderer;
    this.models = models;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
  }

  /** Rebuilds the whole three.js scene from the document. */
  async build(doc: SceneDoc, opts: SceneBuildOptions): Promise<void> {
    this.clear();
    this.materialCache.clear();
    const s = doc.settings;
    const render = opts.project?.render;
    this.renderer.toneMapping =
      render?.toneMapping === 'none'
        ? NoToneMapping
        : render?.toneMapping === 'aces'
          ? ACESFilmicToneMapping
          : render?.toneMapping === 'neutral'
            ? NeutralToneMapping
            : AgXToneMapping;
    this.renderer.toneMappingExposure = render?.exposure ?? 1;
    this.renderer.shadowMap.enabled = render?.shadows ?? true;
    if (opts.studio) {
      this.scene.background = new Color('#2b2d31');
      this.scene.environment = this.environment('studio');
      this.scene.fog = null;
      const key = new DirectionalLight('#ffffff', 2.2);
      key.position.set(3, 5, 4);
      key.castShadow = true;
      this.scene.add(key, new AmbientLight('#ffffff', 0.25));
    } else {
      this.scene.background = new Color(s.background);
      this.scene.environment = s.environment === 'none' ? null : this.environment(s.environment);
      this.scene.environmentIntensity = s.environment === 'outdoor' ? 0.55 : 0.8;
      this.scene.fog = s.fog ? new Fog(s.fog.color, s.fog.near, s.fog.far) : null;
      this.scene.add(new AmbientLight(s.ambientColor, s.ambientIntensity));
    }
    // Create objects parent-first.
    const byId = new Map(doc.entities.map((e) => [e.id, e]));
    const created = new Set<string>();
    const make = async (e: Entity): Promise<void> => {
      if (created.has(e.id)) return;
      if (e.parent && byId.has(e.parent)) await make(byId.get(e.parent)!);
      created.add(e.id);
      const obj = await this.createEntityObject(e, opts);
      const parent = e.parent ? this.objects.get(e.parent) : undefined;
      (parent ?? this.scene).add(obj);
    };
    for (const e of doc.entities) await make(e);
    this.fitShadows();
  }

  clear(): void {
    for (const child of [...this.scene.children]) this.scene.remove(child);
    this.objects.clear();
  }

  /** Adds one entity (e.g. spawned at runtime). Its parent must already exist, or it goes to the root. */
  async addEntity(e: Entity, opts: SceneBuildOptions): Promise<Object3D> {
    const obj = await this.createEntityObject(e, opts);
    const parent = e.parent ? this.objects.get(e.parent) : undefined;
    (parent ?? this.scene).add(obj);
    return obj;
  }

  /** Removes an entity and its descendants. */
  removeEntity(id: string): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    obj.traverse((o) => {
      const eid = o.userData.entityId as string | undefined;
      if (eid) this.objects.delete(eid);
    });
    obj.removeFromParent();
  }

  private async createEntityObject(e: Entity, opts: SceneBuildOptions): Promise<Object3D> {
    const obj = new Group();
    obj.name = e.name;
    obj.userData = { entityId: e.id, tags: e.tags };
    applyTransform(obj, e);
    obj.visible = e.active;
    for (const c of e.components) {
      const child = await this.createComponentObject(e, c, opts);
      if (child) obj.add(child);
    }
    this.objects.set(e.id, obj);
    return obj;
  }

  private async createComponentObject(e: Entity, c: ComponentData, opts: SceneBuildOptions): Promise<Object3D | null> {
    switch (c.type) {
      case 'MeshRenderer': {
        let visual: Object3D | null = null;
        const matDoc = c.material ? opts.materials[c.material as string] : undefined;
        if (c.model) {
          const key = opts.meshKeys[e.id];
          visual = key ? await this.models.instantiate(key) : null;
          if (visual && (matDoc || c.color)) {
            visual.traverse((o) => {
              const mesh = o as Mesh;
              if (!mesh.isMesh) return;
              if (matDoc) mesh.material = this.materialFromDoc(matDoc, c.color as string | undefined);
              else if (c.color) {
                const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
                  const clone = (m as Material).clone() as MeshStandardMaterial;
                  clone.color?.multiply(new Color(c.color as string));
                  return clone;
                });
                mesh.material = Array.isArray(mesh.material) ? mats : mats[0]!;
              }
            });
          }
        }
        if (!visual) {
          const kind = (c.primitive as string | undefined) ?? (c.model ? 'box' : 'box');
          const material = matDoc
            ? this.materialFromDoc(matDoc, c.color as string | undefined)
            : this.materialFromDoc(undefined, (c.color as string | undefined) ?? (c.model ? '#ff00ff' : '#ffffff'));
          visual = new Mesh(primitiveGeometry(kind), material);
        }
        visual.userData.meshRenderer = true;
        visual.visible = c.visible !== false;
        visual.traverse((o) => {
          const mesh = o as Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = c.castShadow !== false;
            mesh.receiveShadow = c.receiveShadow !== false;
          }
        });
        return visual;
      }
      case 'Light':
        return createLight(c);
      case 'Camera': {
        const cam = new PerspectiveCamera((c.fov as number) ?? 60, 16 / 9, (c.near as number) ?? 0.1, (c.far as number) ?? 500);
        cam.userData.primary = c.primary !== false;
        cam.name = 'camera';
        return cam;
      }
      default:
        return null;
    }
  }

  materialFromDoc(doc: MaterialDoc | undefined, tint?: string): MeshStandardMaterial {
    const key = JSON.stringify([doc ?? null, tint ?? null]);
    let m = this.materialCache.get(key);
    if (m) return m;
    m = new MeshStandardMaterial({
      color: new Color(doc?.color ?? '#ffffff'),
      metalness: doc?.metalness ?? 0,
      roughness: doc?.roughness ?? 0.6,
      emissive: new Color(doc?.emissive ?? '#000000'),
      emissiveIntensity: doc?.emissiveIntensity ?? 1,
      opacity: doc?.opacity ?? 1,
      transparent: (doc?.opacity ?? 1) < 1,
      flatShading: doc?.flatShading ?? false,
      side: doc?.doubleSided ? 2 : 0,
      vertexColors: doc?.vertexColors ?? false,
    });
    if (tint) m.color.multiply(new Color(tint));
    if (doc?.map) {
      const tex = this.textures.get(doc.map, doc.mapRepeat ?? [1, 1]);
      if (tex) m.map = tex;
    }
    this.materialCache.set(key, m);
    return m;
  }

  /** Texture registry for material maps (fed by the editor or the headless renderer). */
  readonly textures = new TextureCache();

  private environment(kind: 'studio' | 'outdoor'): import('three').Texture {
    let env = this.envCache.get(kind);
    if (env) return env;
    const pmrem = new PMREMGenerator(this.renderer);
    if (kind === 'studio') env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    else {
      const sky = new Scene();
      sky.background = new Color('#9cc3e6');
      const hemi = new HemisphereLight('#bfe0ff', '#6b5a45', 3);
      sky.add(hemi);
      const room = new RoomEnvironment();
      room.scale.setScalar(0.9);
      sky.add(room);
      env = pmrem.fromScene(sky, 0.02).texture;
    }
    pmrem.dispose();
    this.envCache.set(kind, env);
    return env;
  }

  /** Sizes directional-light shadow cameras to cover the scene's renderable bounds. */
  fitShadows(): void {
    const bounds = this.renderableBounds();
    if (bounds.isEmpty()) return;
    const size = bounds.getSize(new Vector3()).length();
    const center = bounds.getCenter(new Vector3());
    this.scene.traverse((o) => {
      if (!(o instanceof DirectionalLight) || !o.castShadow) return;
      const cam = o.shadow.camera;
      const half = Math.min(80, size / 2 + 2);
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.near = 0.1;
      cam.far = size * 3 + 50;
      o.shadow.mapSize.set(2048, 2048);
      o.shadow.bias = -0.0004;
      o.shadow.normalBias = 0.02;
      // Place the light "behind" the scene center along its direction (target is a child of the light).
      o.updateWorldMatrix(true, true);
      const from = o.getWorldPosition(new Vector3());
      const to = o.target.getWorldPosition(new Vector3());
      const dir = to.sub(from).normalize();
      const lightPos = center.clone().sub(dir.multiplyScalar(size + 10));
      o.position.copy(o.parent ? o.parent.worldToLocal(lightPos) : lightPos);
      o.updateWorldMatrix(true, false);
      o.target.position.copy(o.worldToLocal(center.clone()));
      o.target.updateMatrixWorld();
      cam.updateProjectionMatrix();
    });
  }

  /** World bounds of all visible meshes (optionally only for some entity ids). */
  renderableBounds(ids?: string[]): Box3 {
    const box = new Box3();
    const roots = ids ? ids.map((id) => this.objects.get(id)).filter((o): o is Object3D => !!o) : [this.scene];
    this.scene.updateMatrixWorld(true);
    for (const r of roots) {
      r.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh || !isVisible(mesh)) return;
        mesh.geometry.computeBoundingBox();
        const b = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
        box.union(b);
      });
    }
    return box;
  }

  /** The primary Camera entity's camera, if any. */
  primaryCamera(): PerspectiveCamera | null {
    let found: PerspectiveCamera | null = null;
    this.scene.traverse((o) => {
      if (!found && o instanceof PerspectiveCamera && o.userData.primary && isVisible(o)) found = o;
    });
    return found;
  }
}

function isVisible(o: Object3D): boolean {
  let cur: Object3D | null = o;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

export function applyTransform(obj: Object3D, e: Pick<Entity, 'transform'>): void {
  const t = e.transform;
  obj.position.set(t.position[0], t.position[1], t.position[2]);
  obj.rotation.set(t.rotation[0] * MathUtils.DEG2RAD, t.rotation[1] * MathUtils.DEG2RAD, t.rotation[2] * MathUtils.DEG2RAD, 'XYZ');
  obj.scale.set(t.scale[0], t.scale[1], t.scale[2]);
}

function createLight(c: ComponentData): Object3D | null {
  const color = new Color((c.color as string) ?? '#ffffff');
  const intensity = (c.intensity as number) ?? 1;
  switch (c.kind) {
    case 'directional': {
      const l = new DirectionalLight(color, intensity);
      l.castShadow = !!c.castShadow;
      // shine along the entity's forward (-Z)
      l.position.set(0, 0, 0);
      l.target.position.set(0, 0, -1);
      l.add(l.target);
      return l;
    }
    case 'point': {
      const l = new PointLight(color, intensity * POINT_INTENSITY_SCALE, (c.range as number) ?? 0, 2);
      l.castShadow = !!c.castShadow;
      return l;
    }
    case 'spot': {
      const l = new SpotLight(color, intensity * POINT_INTENSITY_SCALE, (c.range as number) ?? 0, ((c.angle as number) ?? 30) * MathUtils.DEG2RAD, 0.3, 2);
      l.castShadow = !!c.castShadow;
      l.target.position.set(0, 0, -1);
      l.add(l.target);
      return l;
    }
    case 'ambient':
      return new AmbientLight(color, intensity);
    case 'hemisphere':
      return new HemisphereLight(color, new Color((c.groundColor as string) ?? '#444444'), intensity);
    default:
      return null;
  }
}

export { Object3D };
