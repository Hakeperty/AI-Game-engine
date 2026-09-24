/**
 * @aige/modeling: procedural modeling kernel. Model recipes import it as 'aige/model'.
 */
import './fluent.ts';

export { hull, initModeling, intersect, modelingReady, subtract, union } from './boolean.ts';
export { exportGlb, importGlb, readGlbSkeleton } from './export/gltf.ts';
export { type MeshData, type MeshPartData, type MeshPrimitive, toMeshData } from './export/meshdata.ts';
export {
  type Branch,
  type BranchOptions,
  type EyeOptions,
  eye,
  type LeafOptions,
  plants,
  type TerrainNoise,
  type TerrainOptions,
  type TerrainPalette,
  type TreeOptions,
  terrain,
  terrainHeight,
} from './generators.ts';
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
export {
  type ColliderHint,
  type Joint,
  Model,
  type ModelAnimation,
  type ModelPart,
  model,
  type PartMorph,
  type PartSkin,
  type Skeleton,
  type Socket,
  toModel,
} from './model.ts';
export { Noise } from './noise.ts';
export * from './ops/deform.ts';
export {
  type AOOptions,
  type BrushMode,
  type BrushOptions,
  bakeAO,
  brush,
  type DecimateOptions,
  decimate,
  relax,
  repairManifold,
  type SmoothOptions,
  smoothMesh,
} from './ops/organic.ts';
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
  withDefaults,
} from './recipe.ts';
export { type Metaball, type RadiusInput, Sdf, sdf } from './sdf.ts';
export { DETAIL_RESOLUTION, type SdfDetail, type SdfMeshOptions } from './sdf-mesh.ts';
export { type MeshReport, type ModelReport, validateMesh, validateModel } from './validate.ts';

/** Bump when kernel output changes so cached model builds are invalidated. */
export const KERNEL_VERSION = 4;
export {
  type Age,
  type Anatomy,
  type BodyParams,
  computeAnatomy,
  type HeadShape,
  type Sex,
} from './character/anatomy.ts';
export { builtinAnimations, builtinClipAliases, clipToModelAnimation } from './character/animation.ts';
export type { BottomKind, ShoesKind, TopKind } from './character/clothing.ts';
export type { HairStyle } from './character/hair.ts';
export {
  HUMANOID_PRESETS,
  type HumanoidOptions,
  type HumanoidPreset,
  humanoid,
  humanoidRecipe,
  humanoidWeightBones,
  resolveHumanoidOptions,
} from './character/humanoid.ts';
export { humanoidFromMakeHuman, type MakeHumanOptions, makeHumanBone } from './character/makehuman.ts';
export { computeSkin, type SkinOptions, type WeightBone } from './character/skinning.ts';
