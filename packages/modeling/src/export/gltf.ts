import { Document, type Node as GNode, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { encodePng } from '../image.ts';
import { type MaterialSpec, material as makeMaterial } from '../material.ts';
import { hexToRgb, rgbToHex, srgbToLinear, type V3 } from '../math.ts';
import { Model, type Skeleton } from '../model.ts';
import type { PolyMesh } from '../polymesh.ts';
import { PolyMesh as PM } from '../polymesh.ts';
import { type MeshData, type MeshDataOptions, toMeshData } from './meshdata.ts';

const linear = (hex: string): [number, number, number] => {
  const c = hexToRgb(hex);
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
};
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * Writes a model (or MeshData) as a binary glTF (.glb). Sockets become empty nodes named 'socket:<name>'
 * (children of their bone on skinned models). Skinned models also get one node per joint, a skin on every
 * skinned part (JOINTS_0 / WEIGHTS_0, at most 4 normalized influences), and one glTF animation per clip.
 * Clip metadata (loop, duration, next, events, aliases) goes into the root node's `extras.aige.clips`.
 */
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
  // Skeleton: one node per joint (bind rotations are identity, so each node is only offset from its parent).
  const skel = data.skeleton?.joints.length ? data.skeleton : null;
  const jointNodes = new Map<string, GNode>();
  let skin: ReturnType<Document['createSkin']> | null = null;
  if (skel) {
    const byName = new Map(skel.joints.map((j) => [j.name, j]));
    const ibm = new Float32Array(skel.joints.length * 16);
    skel.joints.forEach((j, i) => {
      const parent = j.parent ? byName.get(j.parent) : undefined;
      const t: V3 = parent
        ? [
            j.position[0] - parent.position[0],
            j.position[1] - parent.position[1],
            j.position[2] - parent.position[2],
          ]
        : [j.position[0], j.position[1], j.position[2]];
      const node = doc.createNode(j.name).setTranslation(t);
      jointNodes.set(j.name, node);
      const parentNode = j.parent ? jointNodes.get(j.parent) : undefined;
      (parentNode ?? root).addChild(node);
      // inverse bind matrix = translation by -bindPosition (column-major)
      ibm.set(
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -j.position[0], -j.position[1], -j.position[2], 1],
        i * 16,
      );
    });
    skin = doc
      .createSkin('skeleton')
      .setInverseBindMatrices(
        doc.createAccessor('inverseBindMatrices').setType('MAT4').setArray(ibm).setBuffer(buffer),
      );
    for (const j of skel.joints) skin.addJoint(jointNodes.get(j.name)!);
    const rootJoint = jointNodes.get(skel.joints[0]!.name);
    if (rootJoint) skin.setSkeleton(rootJoint);
  }
  const smallJoints = !!skel && skel.joints.length <= 255;
  for (const part of data.parts) {
    const mesh = doc.createMesh(part.name);
    let skinned = false;
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
      if (skin && skel && p.joints && p.weights) {
        const { joints, weights } = cleanSkin(p.joints, p.weights, skel.joints.length);
        prim
          .setAttribute(
            'JOINTS_0',
            doc
              .createAccessor()
              .setType('VEC4')
              .setArray(smallJoints ? new Uint8Array(joints) : joints)
              .setBuffer(buffer),
          )
          .setAttribute(
            'WEIGHTS_0',
            doc.createAccessor().setType('VEC4').setArray(weights).setBuffer(buffer),
          );
        skinned = true;
      }
      mesh.addPrimitive(prim);
    }
    const node = doc.createNode(part.name).setMesh(mesh);
    if (skinned && skin) node.setSkin(skin);
    root.addChild(node);
  }
  for (const [name, s] of Object.entries(data.sockets)) {
    const q = eulerToQuat(s.rotation);
    const bone = s.bone ? jointNodes.get(s.bone) : undefined;
    const bj = s.bone ? skel?.joints.find((j) => j.name === s.bone) : undefined;
    const t: V3 =
      bone && bj
        ? [s.position[0] - bj.position[0], s.position[1] - bj.position[1], s.position[2] - bj.position[2]]
        : s.position;
    (bone ?? root).addChild(doc.createNode(`socket:${name}`).setTranslation(t).setRotation(q));
  }
  // Animations: one glTF animation per clip, channels on the joint nodes.
  const clips: { name: string; duration: number; loop: boolean; next?: string; events?: unknown[] }[] = [];
  if (skel && data.animations?.length) {
    for (const a of data.animations) {
      const anim = doc.createAnimation(a.name);
      const inputs = new Map<Float32Array, ReturnType<Document['createAccessor']>>();
      let end = 0;
      for (const ch of a.channels) {
        const node = jointNodes.get(ch.joint);
        if (!node || ch.times.length === 0) continue;
        let input = inputs.get(ch.times);
        if (!input) {
          input = doc
            .createAccessor()
            .setType('SCALAR')
            .setArray(new Float32Array(ch.times))
            .setBuffer(buffer);
          inputs.set(ch.times, input);
        }
        end = Math.max(end, ch.times[ch.times.length - 1]!);
        const output = doc
          .createAccessor()
          .setType(ch.path === 'rotation' ? 'VEC4' : 'VEC3')
          .setArray(new Float32Array(ch.values))
          .setBuffer(buffer);
        const sampler = doc
          .createAnimationSampler()
          .setInput(input)
          .setOutput(output)
          .setInterpolation('LINEAR');
        anim.addSampler(sampler);
        anim.addChannel(
          doc.createAnimationChannel().setTargetNode(node).setTargetPath(ch.path).setSampler(sampler),
        );
      }
      clips.push({
        name: a.name,
        duration: a.duration ?? end,
        loop: !!a.loop,
        ...(a.next ? { next: a.next } : {}),
        ...(a.events?.length ? { events: a.events } : {}),
      });
    }
  }
  root.setExtras({
    aige: {
      collider: data.collider,
      bounds: data.bounds,
      triangleCount: data.triangleCount,
      ...(skel ? { skinned: true, joints: skel.joints.map((j) => j.name) } : {}),
      ...(clips.length ? { clips, clipAliases: data.clipAliases ?? {} } : {}),
    },
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
  const doc = await reader().readBinary(glb);
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

/** Validates skin attributes: joint indices in range, weights >= 0 and summing to 1 (unused slots get joint 0). */
function cleanSkin(
  joints: Uint16Array,
  weights: Float32Array,
  jointCount: number,
): { joints: Uint16Array<ArrayBuffer>; weights: Float32Array<ArrayBuffer> } {
  const n = Math.floor(Math.min(joints.length, weights.length) / 4);
  const j = new Uint16Array(n * 4);
  const w = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const ji = joints[v * 4 + k]!;
      const wi = weights[v * 4 + k]!;
      const ok = ji < jointCount && Number.isFinite(wi) && wi > 0;
      j[v * 4 + k] = ok ? ji : 0;
      w[v * 4 + k] = ok ? wi : 0;
      if (ok) sum += wi;
    }
    if (sum <= 1e-8) {
      w[v * 4] = 1;
      continue;
    }
    for (let k = 0; k < 4; k++) w[v * 4 + k] = w[v * 4 + k]! / sum;
  }
  return { joints: j, weights: w };
}

/**
 * Reads the skeleton of a skinned .glb (first skin): joint names, parents and bind positions (world
 * translations of the joint nodes). Null when the file has no skin.
 */
export async function readGlbSkeleton(glb: Uint8Array): Promise<Skeleton | null> {
  const doc = await reader().readBinary(glb);
  const skin = doc.getRoot().listSkins()[0];
  if (!skin) return null;
  const joints = skin.listJoints();
  const names = new Set(joints.map((j) => j.getName()));
  return {
    joints: joints.map((j) => {
      const parent = j.getParentNode();
      const t = j.getWorldTranslation();
      return {
        name: j.getName(),
        parent: parent && names.has(parent.getName()) ? parent.getName() : null,
        position: [t[0], t[1], t[2]] as V3,
      };
    }),
  };
}

/** A glTF reader that understands the standard extensions (e.g. KHR_texture_transform in Poly Haven models). */
function reader(): WebIO {
  return new WebIO().registerExtensions(ALL_EXTENSIONS);
}
