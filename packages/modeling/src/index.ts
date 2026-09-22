/**
 * @aige/modeling: procedural modeling kernel. Model recipes import it as 'aige/model'.
 */
import './fluent.ts';

export { hull, initModeling, intersect, modelingReady, subtract, union } from './boolean.ts';
export { exportGlb, importGlb } from './export/gltf.ts';
export { type MeshData, type MeshPartData, type MeshPrimitive, toMeshData } from './export/meshdata.ts';
export {
  decodePng,
  encodePng,
  fromBase64,
  proceduralTexture,
  type RgbaImage,
  type TextureKind,
  toBase64,
} from './image.ts';
export {
  DEFAULT_MATERIAL,
  type MaterialInput,
  type MaterialSpec,
  MaterialSpecSchema,
  material,
  materials,
} from './material.ts';
export * from './math.ts';
export { type ColliderHint, Model, type ModelPart, model, type Socket, toModel } from './model.ts';
export { Noise } from './noise.ts';
export * from './ops/deform.ts';
export { curves, extrudeShape, sweep, tube } from './ops/sweep.ts';
export { type ExtrudeOptions, extrude, inset, quadify, subdivide, vertexNormals } from './ops/topology.ts';
export { type Bounds, type Face, type FaceInfo, type FaceSelector, PolyMesh } from './polymesh.ts';
export {
  box,
  capsule,
  cone,
  cylinder,
  icosphere,
  lathe,
  plane,
  roundedBox,
  shapes,
  sphere,
  torus,
} from './primitives.ts';
export {
  type BuildContext,
  type BuildResult,
  buildRecipe,
  defineModel,
  describeParams,
  isRecipe,
  type ParamDef,
  p,
  type Recipe,
  resolveParams,
} from './recipe.ts';
export { Sdf, sdf } from './sdf.ts';
export { type MeshReport, type ModelReport, validateMesh, validateModel } from './validate.ts';

/** Bump when kernel output changes so cached model builds are invalidated. */
export const KERNEL_VERSION = 1;
