/**
 * Automatic skin weights for humanoid parts.
 *
 * Each bone owns one or more "weight segments" (usually joint -> child joint) and a radius (the typical body
 * thickness around it). A vertex is influenced by bones in inverse proportion to (distance / radius)^4, so
 * joints blend over roughly one limb radius; bones whose segment is not reachable through the body (the
 * straight path leaves a capsule "stick figure" of the body) are strongly damped, which stops arms pulling on
 * the ribs and legs pulling on each other. Weights are then diffused over the mesh (Laplacian smoothing) and
 * reduced to the 4 strongest, normalized influences. Clothing and hair use the same field, so they follow the
 * body underneath.
 */
import { clamp, smoothstep, type V3 } from '../math.ts';
import type { PartSkin } from '../model.ts';
import type { PolyMesh } from '../polymesh.ts';

export interface WeightBone {
  name: string;
  /** Index into skeleton.joints. */
  index: number;
  /** Segments (a, b) in model space. */
  segs: [V3, V3][];
  /** Typical body radius around the bone (meters). */
  radius: number;
  /** +1 = left leg chain, -1 = right leg chain, 0 = no side mask. */
  side: -1 | 0 | 1;
  /** Excluded from the distance field (weights only come from overrides, e.g. the jaw). */
  explicit?: boolean;
}

export interface SkinOptions {
  /** Every vertex gets weight 1 on this bone (eyes, rigid props). */
  rigid?: string;
  /** Only these bones may influence the part. */
  only?: string[];
  /** Laplacian smoothing iterations over the mesh (default 4). */
  smooth?: number;
  /** Adds explicit weights: returns [bone, weight 0..1] pairs that are blended in after smoothing. */
  override?: (p: V3) => [string, number][] | null;
}

function segDist(p: V3, a: V3, b: V3, out?: V3): number {
  const bx = b[0] - a[0];
  const by = b[1] - a[1];
  const bz = b[2] - a[2];
  const px = p[0] - a[0];
  const py = p[1] - a[1];
  const pz = p[2] - a[2];
  const l2 = bx * bx + by * by + bz * bz;
  const t = l2 > 1e-12 ? clamp((px * bx + py * by + pz * bz) / l2, 0, 1) : 0;
  const cx = a[0] + bx * t;
  const cy = a[1] + by * t;
  const cz = a[2] + bz * t;
  if (out) {
    out[0] = cx;
    out[1] = cy;
    out[2] = cz;
  }
  return Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz);
}

/** Signed distance to the capsule stick figure (bones inflated by `inflate` x radius). */
function figureDist(bones: WeightBone[], p: V3, inflate: number): number {
  let best = Infinity;
  for (const b of bones) {
    const r = b.radius * inflate;
    for (const [a, c] of b.segs) {
      const d = segDist(p, a, c) - r;
      if (d < best) best = d;
    }
  }
  return best;
}

/** Computes per-vertex skin (4 joints + weights) for `mesh`. */
export function computeSkin(mesh: PolyMesh, bones: WeightBone[], opts: SkinOptions = {}): PartSkin {
  const n = mesh.p.length;
  const joints = new Uint16Array(n * 4);
  const weights = new Float32Array(n * 4);
  if (opts.rigid) {
    const b = bones.find((x) => x.name === opts.rigid);
    for (let i = 0; i < n; i++) {
      joints[i * 4] = b?.index ?? 0;
      weights[i * 4] = 1;
    }
    return { joints, weights };
  }
  const active = bones.filter((b) => !b.explicit && (!opts.only || opts.only.includes(b.name)));
  const nb = active.length;
  const W = new Float32Array(n * nb);
  const dn = new Float64Array(nb);
  const close: V3 = [0, 0, 0];
  const probe: V3 = [0, 0, 0];
  const order = new Int32Array(nb);
  for (let i = 0; i < n; i++) {
    const p = mesh.p[i]!;
    for (let k = 0; k < nb; k++) {
      const b = active[k]!;
      let d = Infinity;
      for (const [a, c] of b.segs) d = Math.min(d, segDist(p, a, c));
      dn[k] = d / b.radius;
      order[k] = k;
    }
    order.sort((a, b) => dn[a]! - dn[b]!);
    const cand = Math.min(nb, 6);
    let sum = 0;
    for (let r = 0; r < cand; r++) {
      const k = order[r]!;
      const b = active[k]!;
      // visibility: the path from the vertex to the bone should stay inside the body figure
      let best = Infinity;
      for (const [a, c] of b.segs) {
        const d = segDist(p, a, c, probe);
        if (d < best) {
          best = d;
          close[0] = probe[0];
          close[1] = probe[1];
          close[2] = probe[2];
        }
      }
      let vis = 1;
      for (const t of [0.4, 0.65, 0.88]) {
        const q: V3 = [
          p[0] + (close[0] - p[0]) * t,
          p[1] + (close[1] - p[1]) * t,
          p[2] + (close[2] - p[2]) * t,
        ];
        if (figureDist(bones, q, 1.35) > 0.004) {
          vis = 0.03;
          break;
        }
      }
      let side = 1;
      if (b.side !== 0) side = smoothstep(-0.03, 0.012, p[0] * b.side);
      const x = dn[k]!;
      const w = (vis * side) / (x * x * x * x + 1e-3);
      W[i * nb + k] = w;
      sum += w;
    }
    if (sum > 0)
      for (let r = 0; r < cand; r++) {
        const o = i * nb + order[r]!;
        W[o] = W[o]! / sum;
      }
    else W[i * nb + order[0]!] = 1;
  }
  // diffuse over the mesh
  const iters = opts.smooth ?? 4;
  if (iters > 0) {
    const nbrs: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
    for (const f of mesh.f) {
      for (let a = 0; a < f.v.length; a++) {
        const u = f.v[a]!;
        const v = f.v[(a + 1) % f.v.length]!;
        nbrs[u]!.add(v);
        nbrs[v]!.add(u);
      }
    }
    const adj = nbrs.map((s) => Int32Array.from(s));
    let src = W;
    let dst = new Float32Array(W.length);
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n; i++) {
        const nb2 = adj[i]!;
        const o = i * nb;
        if (nb2.length === 0) {
          for (let k = 0; k < nb; k++) dst[o + k] = src[o + k]!;
          continue;
        }
        const inv = 0.5 / nb2.length;
        for (let k = 0; k < nb; k++) {
          let acc = 0;
          for (let m = 0; m < nb2.length; m++) acc += src[nb2[m]! * nb + k]!;
          dst[o + k] = 0.5 * src[o + k]! + acc * inv;
        }
      }
      const t = src;
      src = dst;
      dst = t;
    }
    W.set(src);
  }
  const indexOf = new Map(bones.map((b) => [b.name, b.index]));
  const top = new Int32Array(4);
  const topW = new Float64Array(4);
  for (let i = 0; i < n; i++) {
    top.fill(-1);
    topW.fill(0);
    const o = i * nb;
    for (let k = 0; k < nb; k++) {
      const w = W[o + k]!;
      if (w <= topW[3]!) continue;
      let pos = 3;
      while (pos > 0 && w > topW[pos - 1]!) {
        topW[pos] = topW[pos - 1]!;
        top[pos] = top[pos - 1]!;
        pos--;
      }
      topW[pos] = w;
      top[pos] = k;
    }
    const entries: [number, number][] = [];
    for (let s = 0; s < 4; s++)
      if (top[s]! >= 0 && topW[s]! > 0.004) entries.push([active[top[s]!]!.index, topW[s]!]);
    const ov = opts.override?.(mesh.p[i]!);
    if (ov) {
      for (const [name, w] of ov) {
        const idx = indexOf.get(name);
        if (idx === undefined || w <= 0) continue;
        const ww = clamp(w, 0, 1);
        for (const e of entries) e[1] *= 1 - ww;
        const hit = entries.find((e) => e[0] === idx);
        if (hit) hit[1] += ww;
        else entries.push([idx, ww]);
      }
      entries.sort((a, b) => b[1] - a[1]);
      entries.length = Math.min(4, entries.length);
    }
    let sum = 0;
    for (const e of entries) sum += e[1];
    if (entries.length === 0 || sum <= 0) {
      joints[i * 4] = active[order[0] ?? 0]?.index ?? 0;
      weights[i * 4] = 1;
      continue;
    }
    entries.forEach((e, s) => {
      joints[i * 4 + s] = e[0];
      weights[i * 4 + s] = e[1] / sum;
    });
  }
  return { joints, weights };
}
