/**
 * Chainable methods on PolyMesh, e.g. box().extrude('top', 0.5).subdivide(2).displace({ amount: 0.05 }).
 * Implemented here (not in polymesh.ts) to keep the kernel free of import cycles.
 */
import { intersect, subtract, union } from './boolean.ts';
import type { Axis, V3 } from './math.ts';
import {
  arrayLinear,
  arrayRadial,
  bend,
  displace,
  inflate,
  jitter,
  spherize,
  taper,
  twist,
  uvBox,
  uvCylindrical,
  uvPlanar,
  uvSpherical,
} from './ops/deform.ts';
import {
  type AOOptions,
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
import { type ExtrudeOptions, extrude, inset, subdivide } from './ops/topology.ts';
import { type FaceSelector, PolyMesh } from './polymesh.ts';
import { type MeshReport, validateMesh } from './validate.ts';

declare module './polymesh.ts' {
  interface PolyMesh {
    /** Extrude selected faces along their normal (or a direction). Negative distance pushes inward. */
    extrude(sel: FaceSelector, distance: number, opts?: ExtrudeOptions): PolyMesh;
    /** Shrink each selected face by `amount`, adding a rim of quads around it. */
    inset(sel: FaceSelector, amount: number, opts?: { rimGroup?: string }): PolyMesh;
    /** Catmull-Clark subdivision (smooth: false only splits). */
    subdivide(levels?: number, opts?: { smooth?: boolean }): PolyMesh;
    /** Noise displacement along normals. */
    displace(opts?: {
      amount?: number;
      scale?: number;
      octaves?: number;
      seed?: number;
      sel?: FaceSelector;
      ridged?: boolean;
    }): PolyMesh;
    jitter(amount?: number, seed?: number): PolyMesh;
    inflate(distance: number): PolyMesh;
    twist(degreesPerUnit: number, axis?: Axis): PolyMesh;
    taper(start: number, end: number, axis?: Axis): PolyMesh;
    bend(degrees: number): PolyMesh;
    spherize(amount?: number): PolyMesh;
    /** `count` copies offset cumulatively by `offset`. */
    repeat(count: number, offset: V3): PolyMesh;
    /** `count` copies rotated around an axis. */
    radial(count: number, opts?: { axis?: Axis; angle?: number }): PolyMesh;
    uvBox(scale?: number, sel?: FaceSelector): PolyMesh;
    uvPlanar(axis?: Axis, scale?: number, sel?: FaceSelector): PolyMesh;
    uvCylindrical(scale?: number, sel?: FaceSelector): PolyMesh;
    uvSpherical(sel?: FaceSelector): PolyMesh;
    /** Solid boolean union (needs initModeling()). */
    union(...others: PolyMesh[]): PolyMesh;
    /** Solid boolean difference: cuts the other meshes out of this one. */
    subtract(...others: PolyMesh[]): PolyMesh;
    intersect(...others: PolyMesh[]): PolyMesh;
    validate(): MeshReport;
    /** Taubin smoothing (no shrinking; closed meshes keep their volume). */
    smoothMesh(opts?: SmoothOptions): PolyMesh;
    /** Evens out vertex spacing by sliding vertices along the surface. */
    relax(opts?: { iterations?: number; strength?: number; sel?: FaceSelector }): PolyMesh;
    /** Sculpt brush: inflate, grab, pinch, flatten, smooth or noise with smooth falloff. */
    brush(opts: BrushOptions): PolyMesh;
    /** Fewer triangles (meshoptimizer): target > 1 = triangle count, 0..1 = ratio. Needs initModeling(). */
    decimate(target: number, opts?: DecimateOptions): PolyMesh;
    /** Bakes ambient occlusion into vertex colors (darker creases and undersides). */
    bakeAO(opts?: AOOptions): PolyMesh;
    /** Splits edges shared by more than two faces so the mesh becomes manifold. */
    repairManifold(): PolyMesh;
  }
}

const P = PolyMesh.prototype;
P.extrude = function (sel, distance, opts) {
  return extrude(this, sel, distance, opts);
};
P.inset = function (sel, amount, opts) {
  return inset(this, sel, amount, opts);
};
P.subdivide = function (levels = 1, opts) {
  return subdivide(this, levels, opts);
};
P.displace = function (opts) {
  return displace(this, opts);
};
P.jitter = function (amount, seed) {
  return jitter(this, amount, seed);
};
P.inflate = function (distance) {
  return inflate(this, distance);
};
P.twist = function (deg, axis) {
  return twist(this, deg, axis);
};
P.taper = function (start, end, axis) {
  return taper(this, start, end, axis);
};
P.bend = function (deg) {
  return bend(this, deg);
};
P.spherize = function (amount) {
  return spherize(this, amount);
};
P.repeat = function (count, offset) {
  return arrayLinear(this, count, offset);
};
P.radial = function (count, opts) {
  return arrayRadial(this, count, opts);
};
P.uvBox = function (scale, sel) {
  return uvBox(this, scale, sel);
};
P.uvPlanar = function (axis, scale, sel) {
  return uvPlanar(this, axis, scale, sel);
};
P.uvCylindrical = function (scale, sel) {
  return uvCylindrical(this, scale, sel);
};
P.uvSpherical = function (sel) {
  return uvSpherical(this, sel);
};
P.union = function (...others) {
  return union(this, ...others);
};
P.subtract = function (...others) {
  return subtract(this, ...others);
};
P.intersect = function (...others) {
  return intersect(this, ...others);
};
P.validate = function () {
  return validateMesh(this);
};
P.smoothMesh = function (opts) {
  return smoothMesh(this, opts);
};
P.relax = function (opts) {
  return relax(this, opts);
};
P.brush = function (opts) {
  return brush(this, opts);
};
P.decimate = function (target, opts) {
  return decimate(this, target, opts);
};
P.bakeAO = function (opts) {
  return bakeAO(this, opts);
};
P.repairManifold = function () {
  return repairManifold(this);
};
