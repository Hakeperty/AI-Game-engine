import {
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Unit-size built-in primitives, matching the MeshRenderer 'primitive' docs. */
const primitiveCache = new Map<string, BufferGeometry>();

export function primitiveGeometry(kind: string): BufferGeometry {
  let g = primitiveCache.get(kind);
  if (g) return g;
  switch (kind) {
    case 'box':
      g = new BoxGeometry(1, 1, 1);
      break;
    case 'sphere':
      g = new SphereGeometry(0.5, 32, 16);
      break;
    case 'cylinder':
      g = new CylinderGeometry(0.5, 0.5, 1, 32);
      break;
    case 'cone':
      g = new ConeGeometry(0.5, 1, 32);
      break;
    case 'capsule':
      g = new CapsuleGeometry(0.5, 1, 8, 16);
      break;
    case 'plane':
      g = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      break;
    case 'torus':
      g = new TorusGeometry(0.35, 0.15, 16, 48).rotateX(Math.PI / 2);
      break;
    default:
      g = new BoxGeometry(1, 1, 1);
  }
  primitiveCache.set(kind, g);
  return g;
}

interface AigeMaterialExtras {
  flatShading?: boolean;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
}

/** Applies AIGE material extras (glTF can't express flat shading or emissive intensity > 1). */
function fixMaterial(mat: Material): void {
  const extras = (mat.userData as { aige?: AigeMaterialExtras }).aige;
  if (!extras || !(mat instanceof MeshStandardMaterial)) return;
  if (extras.flatShading) mat.flatShading = true;
  if (extras.emissive && extras.emissiveIntensity !== undefined) {
    // the exporter stores emissive * intensity clamped to 1; restore the real color and intensity
    mat.emissive.set(extras.emissive);
    mat.emissiveIntensity = extras.emissiveIntensity;
  }
  if (extras.opacity !== undefined && extras.opacity < 1) {
    mat.transparent = true;
    mat.depthWrite = false;
  }
  mat.needsUpdate = true;
}

function decodeBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

/** Loads and caches GLB models; returns fresh clones for each entity. */
export class ModelCache {
  private readonly loader = new GLTFLoader();
  private readonly templates = new Map<string, Promise<Object3D>>();

  has(key: string): boolean {
    return this.templates.has(key);
  }

  /** Registers a model from GLB bytes (ArrayBuffer or base64). */
  add(key: string, glb: ArrayBuffer | string): Promise<Object3D> {
    const existing = this.templates.get(key);
    if (existing) return existing;
    const data = typeof glb === 'string' ? decodeBase64(glb) : glb;
    const p = this.loader.parseAsync(data, '').then((gltf) => {
      const root = gltf.scene;
      root.traverse((o) => {
        if ((o as Mesh).isMesh) {
          const mesh = o as Mesh;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach(fixMaterial);
        }
      });
      return root;
    });
    this.templates.set(key, p);
    return p;
  }

  /** Registers a model from a URL (editor: aige-asset://...). */
  addUrl(key: string, url: string): Promise<Object3D> {
    const existing = this.templates.get(key);
    if (existing) return existing;
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        this.templates.delete(key);
        return this.add(key, buf);
      });
    this.templates.set(key, p);
    return p;
  }

  invalidate(key: string): void {
    this.templates.delete(key);
  }

  async instantiate(key: string): Promise<Object3D | null> {
    const t = this.templates.get(key);
    if (!t) return null;
    const template = await t;
    return template.clone(true);
  }
}
