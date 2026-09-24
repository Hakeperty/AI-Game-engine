import type { MaterialDoc } from '@aige/core';
import { type Document, type Material, type Primitive, type Texture, WebIO } from '@gltf-transform/core';
import { KHRTextureTransform } from '@gltf-transform/extensions';

/** Material overrides for a baked model: one for every part, or per part name (MeshRenderer.materials). */
export interface MaterialOverrides {
  all?: MaterialDoc;
  parts: Record<string, MaterialDoc>;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linear = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => toLinear(Number.parseInt(h.slice(i, i + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
};

const mimeOf = (path: string) => (/\.png$/i.test(path) ? 'image/png' : 'image/jpeg');

/**
 * Applies AIGE material docs (scanned PBR textures: color, normal, packed AO/roughness/metal) to a GLB's
 * parts and embeds the textures, so Godot imports finished materials. Parts without UVs get box-projected
 * UVs in meters, which is what `mapRepeat` (1 / texture size in meters) expects.
 */
export async function applyMaterialOverrides(
  glb: Uint8Array,
  overrides: MaterialOverrides,
  readImage: (path: string) => Promise<Uint8Array | null>,
  opts: { embedTextures?: boolean } = {},
): Promise<{ glb: Uint8Array; warnings: string[] }> {
  const embed = opts.embedTextures ?? true;
  const warnings: string[] = [];
  const io = new WebIO().registerExtensions([KHRTextureTransform]);
  const doc = await io.readBinary(glb);
  const transformExt = doc.createExtension(KHRTextureTransform);
  const textures = new Map<string, Texture | null>();
  const materials = new Map<MaterialDoc, Material>();

  const texture = async (path: string | undefined): Promise<Texture | null> => {
    if (!path || !embed) return null;
    if (!textures.has(path)) {
      const bytes = await readImage(path);
      if (!bytes) warnings.push(`Texture '${path}' not found.`);
      textures.set(
        path,
        bytes ? doc.createTexture(path.split('/').pop()!).setImage(bytes).setMimeType(mimeOf(path)) : null,
      );
    }
    return textures.get(path) ?? null;
  };

  const material = async (md: MaterialDoc): Promise<Material> => {
    const cached = materials.get(md);
    if (cached) return cached;
    const [r, g, b] = linear(md.color);
    const m = doc
      .createMaterial('aige')
      .setBaseColorFactor([r, g, b, md.opacity])
      .setRoughnessFactor(md.roughness)
      .setMetallicFactor(md.metalness)
      .setDoubleSided(md.doubleSided)
      .setEmissiveFactor(
        linear(md.emissive).map((c) => Math.min(1, c * md.emissiveIntensity)) as [number, number, number],
      );
    if (md.alphaCutoff > 0) m.setAlphaMode('MASK').setAlphaCutoff(md.alphaCutoff);
    else if (md.opacity < 1) m.setAlphaMode('BLEND');
    const [su, sv] = md.mapRepeat ?? [1, 1];
    const repeat = (info: ReturnType<Material['getBaseColorTextureInfo']>) => {
      if (info && (su !== 1 || sv !== 1))
        info.setExtension('KHR_texture_transform', transformExt.createTransform().setScale([su, sv]));
    };
    const color = await texture(md.map);
    if (color) {
      m.setBaseColorTexture(color);
      repeat(m.getBaseColorTextureInfo());
    }
    const normal = await texture(md.normalMap);
    if (normal) {
      m.setNormalTexture(normal).setNormalScale(md.normalScale);
      repeat(m.getNormalTextureInfo());
    }
    const orm = await texture(md.ormMap);
    if (orm) {
      m.setMetallicRoughnessTexture(orm).setOcclusionTexture(orm).setOcclusionStrength(md.aoIntensity);
      repeat(m.getMetallicRoughnessTextureInfo());
      repeat(m.getOcclusionTextureInfo());
    }
    materials.set(md, m);
    return m;
  };

  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const md = overrides.parts[node.getName()] ?? overrides.all;
    if (!md) continue;
    const mat = await material(md);
    for (const prim of mesh.listPrimitives()) {
      prim.setMaterial(mat);
      if (!md.vertexColors) prim.setAttribute('COLOR_0', null);
      if (!prim.getAttribute('TEXCOORD_0') && (md.map || md.normalMap || md.ormMap)) boxUvs(doc, prim);
      // Without embedded textures the engine assigns the material itself; keep the UVs and drop the tint.
    }
  }
  return { glb: await io.writeBinary(doc), warnings };
}

/** Box-projected UVs in meters (dominant normal axis). */
function boxUvs(doc: Document, prim: Primitive): void {
  const pos = prim.getAttribute('POSITION');
  const nor = prim.getAttribute('NORMAL');
  if (!pos) return;
  const n = pos.getCount();
  const uv = new Float32Array(n * 2);
  const p = [0, 0, 0];
  const q = [0, 1, 0];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, p);
    if (nor) nor.getElement(i, q);
    const ax = Math.abs(q[0]!);
    const ay = Math.abs(q[1]!);
    const az = Math.abs(q[2]!);
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) [u, v] = [p[0]!, p[2]!];
    else if (ax >= az) [u, v] = [p[2]!, -p[1]!];
    else [u, v] = [p[0]!, -p[1]!];
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  const buffer = doc.getRoot().listBuffers()[0];
  prim.setAttribute(
    'TEXCOORD_0',
    doc
      .createAccessor()
      .setType('VEC2')
      .setArray(uv)
      .setBuffer(buffer ?? null),
  );
}
