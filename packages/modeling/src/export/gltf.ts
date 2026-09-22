import { Document, type Node as GNode, WebIO } from '@gltf-transform/core';
import { encodePng } from '../image.ts';
import { type MaterialSpec, material as makeMaterial } from '../material.ts';
import { hexToRgb, rgbToHex, srgbToLinear, type V3 } from '../math.ts';
import { Model } from '../model.ts';
import type { PolyMesh } from '../polymesh.ts';
import { PolyMesh as PM } from '../polymesh.ts';
import { type MeshData, type MeshDataOptions, toMeshData } from './meshdata.ts';

const linear = (hex: string): [number, number, number] => {
  const c = hexToRgb(hex);
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
};
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** Writes a model (or MeshData) as a binary glTF (.glb). Sockets become empty nodes named 'socket:<name>'. */
export async function exportGlb(
  input: Model | PolyMesh | MeshData,
  opts: MeshDataOptions & { name?: string } = {},
): Promise<Uint8Array> {
  const data: MeshData = input instanceof Model || input instanceof PM ? toMeshData(input, opts) : input;
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene(opts.name ?? 'model');
  const root = doc.createNode(opts.name ?? 'model');
  scene.addChild(root);
  const matCache = new Map<string, ReturnType<Document['createMaterial']>>();
  const getMaterial = (
    m: MaterialSpec,
    texture: MeshData['parts'][number]['primitives'][number]['texture'],
  ) => {
    const key = JSON.stringify(m);
    let mat = matCache.get(key);
    if (mat) return mat;
    const [r, g, b] = linear(m.color);
    mat = doc
      .createMaterial(m.name ?? 'material')
      .setBaseColorFactor([r, g, b, m.opacity])
      .setMetallicFactor(m.metalness)
      .setRoughnessFactor(m.roughness)
      .setEmissiveFactor(
        linear(m.emissive).map((c) => Math.min(1, c * m.emissiveIntensity)) as [number, number, number],
      )
      .setDoubleSided(m.doubleSided);
    if (m.opacity < 1) mat.setAlphaMode('BLEND');
    if (texture) {
      const tex = doc.createTexture('texture').setImage(encodePng(texture)).setMimeType('image/png');
      mat.setBaseColorTexture(tex);
    }
    mat.setExtras({ aige: m });
    matCache.set(key, mat);
    return mat;
  };
  for (const part of data.parts) {
    const mesh = doc.createMesh(part.name);
    for (const p of part.primitives) {
      const prim = doc
        .createPrimitive()
        .setAttribute(
          'POSITION',
          doc.createAccessor().setType('VEC3').setArray(p.positions).setBuffer(buffer),
        )
        .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(p.normals).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(p.indices).setBuffer(buffer))
        .setMaterial(getMaterial(p.material, p.texture));
      if (p.uvs)
        prim.setAttribute(
          'TEXCOORD_0',
          doc.createAccessor().setType('VEC2').setArray(p.uvs).setBuffer(buffer),
        );
      if (p.colors)
        prim.setAttribute(
          'COLOR_0',
          doc.createAccessor().setType('VEC3').setArray(p.colors).setBuffer(buffer),
        );
      mesh.addPrimitive(prim);
    }
    root.addChild(doc.createNode(part.name).setMesh(mesh));
  }
  for (const [name, s] of Object.entries(data.sockets)) {
    const q = eulerToQuat(s.rotation);
    root.addChild(doc.createNode(`socket:${name}`).setTranslation(s.position).setRotation(q));
  }
  root.setExtras({
    aige: { collider: data.collider, bounds: data.bounds, triangleCount: data.triangleCount },
  });
  return new WebIO().writeBinary(doc);
}

function eulerToQuat(deg: V3): [number, number, number, number] {
  const [x, y, z] = deg.map((d) => (d * Math.PI) / 360) as V3;
  const c1 = Math.cos(x);
  const c2 = Math.cos(y);
  const c3 = Math.cos(z);
  const s1 = Math.sin(x);
  const s2 = Math.sin(y);
  const s3 = Math.sin(z);
  // XYZ order (matches three.js)
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/**
 * Reads a .glb into a Model (triangles). Node transforms are baked into the vertices.
 * Materials keep base color, metalness, roughness and emissive; vertex colors are preserved.
 */
export async function importGlb(glb: Uint8Array): Promise<Model> {
  const doc = await new WebIO().readBinary(glb);
  const model = new Model();
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) return model;
  const visit = (node: GNode, parentMatrix: number[]) => {
    const local = node.getMatrix() as unknown as number[];
    const world = mat4Mul(parentMatrix, local);
    const name = node.getName();
    if (name.startsWith('socket:')) {
      model.socket(name.slice(7), [world[12]!, world[13]!, world[14]!]);
    }
    const mesh = node.getMesh();
    if (mesh) {
      const pm = new PM();
      pm.materials = [];
      for (const prim of mesh.listPrimitives()) {
        const posAcc = prim.getAttribute('POSITION');
        if (!posAcc) continue;
        const pos = posAcc.getArray()!;
        const uvAcc = prim.getAttribute('TEXCOORD_0');
        const colAcc = prim.getAttribute('COLOR_0');
        const idxAcc = prim.getIndices();
        const base = pm.p.length;
        for (let i = 0; i < posAcc.getCount(); i++) {
          const x = pos[i * 3]!;
          const y = pos[i * 3 + 1]!;
          const z = pos[i * 3 + 2]!;
          pm.p.push([
            world[0]! * x + world[4]! * y + world[8]! * z + world[12]!,
            world[1]! * x + world[5]! * y + world[9]! * z + world[13]!,
            world[2]! * x + world[6]! * y + world[10]! * z + world[14]!,
          ]);
        }
        const gm = prim.getMaterial();
        const extras = gm?.getExtras() as { aige?: MaterialSpec } | undefined;
        let spec: MaterialSpec;
        if (extras?.aige) spec = makeMaterial(extras.aige);
        else if (gm) {
          const f = gm.getBaseColorFactor();
          const e = gm.getEmissiveFactor();
          spec = makeMaterial({
            name: gm.getName() || undefined,
            color: rgbToHex([toSrgb(f[0]), toSrgb(f[1]), toSrgb(f[2])]),
            opacity: f[3],
            metalness: gm.getMetallicFactor(),
            roughness: gm.getRoughnessFactor(),
            emissive: rgbToHex([toSrgb(e[0]), toSrgb(e[1]), toSrgb(e[2])]),
            doubleSided: gm.getDoubleSided(),
          });
        } else spec = makeMaterial({});
        const slot = pm.materials.length;
        pm.materials.push(spec);
        const count = idxAcc ? idxAcc.getCount() : posAcc.getCount();
        const idx = idxAcc?.getArray();
        const uv = uvAcc?.getArray();
        const col = colAcc?.getArray();
        const colSize = colAcc?.getElementSize() ?? 3;
        for (let t = 0; t + 2 < count; t += 3) {
          const tri = [0, 1, 2].map((k) => (idx ? idx[t + k]! : t + k));
          pm.f.push({
            v: tri.map((i) => base + i),
            uv: uv ? tri.map((i) => [uv[i * 2]!, 1 - uv[i * 2 + 1]!] as [number, number]) : null,
            c: col
              ? tri.map(
                  (i) =>
                    [
                      toSrgb(col[i * colSize]!),
                      toSrgb(col[i * colSize + 1]!),
                      toSrgb(col[i * colSize + 2]!),
                    ] as V3,
                )
              : null,
            g: '',
            m: slot,
            sm: true,
          });
        }
      }
      if (pm.materials.length === 0) pm.materials = [makeMaterial({})];
      model.add(pm.weld(1e-6), name || undefined);
    }
    for (const child of node.listChildren()) visit(child, world);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const n of scene.listChildren()) {
    const extras = n.getExtras() as { aige?: { collider?: Model['collider'] } } | undefined;
    if (extras?.aige?.collider) model.setCollider(extras.aige.collider);
    visit(n, identity);
  }
  return model;
}

function mat4Mul(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  return out;
}
