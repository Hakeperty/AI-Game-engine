/**
 * Tiny allocation-light quaternion / vector helpers for the animation system (isomorphic, no three.js).
 * Quaternions are [x, y, z, w]; Euler angles are degrees.
 */

export type Quat = [number, number, number, number];
export type V3 = [number, number, number];

const D2R = Math.PI / 180;

export const quatIdentity = (): Quat => [0, 0, 0, 1];

export function quatAxisAngle(axis: ArrayLike<number>, deg: number): Quat {
  const l = Math.hypot(axis[0]!, axis[1]!, axis[2]!) || 1;
  const h = (deg * D2R) / 2;
  const s = Math.sin(h) / l;
  return [axis[0]! * s, axis[1]! * s, axis[2]! * s, Math.cos(h)];
}

/** a * b (apply b first, then a). */
export function quatMul(a: ArrayLike<number>, b: ArrayLike<number>, out: Quat = [0, 0, 0, 1]): Quat {
  const ax = a[0]!;
  const ay = a[1]!;
  const az = a[2]!;
  const aw = a[3]!;
  const bx = b[0]!;
  const by = b[1]!;
  const bz = b[2]!;
  const bw = b[3]!;
  out[0] = ax * bw + aw * bx + ay * bz - az * by;
  out[1] = ay * bw + aw * by + az * bx - ax * bz;
  out[2] = az * bw + aw * bz + ax * by - ay * bx;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/** Product of several quaternions, left to right: quatChain(a, b, c) = a * b * c. */
export function quatChain(...qs: readonly ArrayLike<number>[]): Quat {
  let out: Quat = [0, 0, 0, 1];
  for (const q of qs) out = quatMul(out, q);
  return out;
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= l;
  q[1] /= l;
  q[2] /= l;
  q[3] /= l;
  return q;
}

export function quatConj(q: ArrayLike<number>): Quat {
  return [-q[0]!, -q[1]!, -q[2]!, q[3]!];
}

/**
 * Euler degrees -> quaternion. order 'XYZ' matches three.js / entity rotations (intrinsic X then Y then Z);
 * 'YXZ' is yaw-pitch-roll (used for spine bones: turn, then bend, then lean).
 */
export function quatFromEuler(x: number, y: number, z: number, order: 'XYZ' | 'YXZ' = 'XYZ'): Quat {
  const c1 = Math.cos((x * D2R) / 2);
  const c2 = Math.cos((y * D2R) / 2);
  const c3 = Math.cos((z * D2R) / 2);
  const s1 = Math.sin((x * D2R) / 2);
  const s2 = Math.sin((y * D2R) / 2);
  const s3 = Math.sin((z * D2R) / 2);
  if (order === 'YXZ') {
    return [
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 - s1 * s2 * c3,
      c1 * c2 * c3 + s1 * s2 * s3,
    ];
  }
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** Spherical interpolation (shortest path). Writes into `out` (may alias a). */
export function quatSlerp(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  t: number,
  out: Quat = [0, 0, 0, 1],
): Quat {
  let bx = b[0]!;
  let by = b[1]!;
  let bz = b[2]!;
  let bw = b[3]!;
  const ax = a[0]!;
  const ay = a[1]!;
  const az = a[2]!;
  const aw = a[3]!;
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let k0: number;
  let k1: number;
  if (cos > 0.9995) {
    k0 = 1 - t;
    k1 = t;
  } else {
    const th = Math.acos(Math.min(1, cos));
    const s = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / s;
    k1 = Math.sin(t * th) / s;
  }
  out[0] = ax * k0 + bx * k1;
  out[1] = ay * k0 + by * k1;
  out[2] = az * k0 + bz * k1;
  out[3] = aw * k0 + bw * k1;
  return quatNormalize(out);
}

/** Rotates vector v by quaternion q. */
export function quatRotate(q: ArrayLike<number>, v: ArrayLike<number>, out: V3 = [0, 0, 0]): V3 {
  const qx = q[0]!;
  const qy = q[1]!;
  const qz = q[2]!;
  const qw = q[3]!;
  const vx = v[0]!;
  const vy = v[1]!;
  const vz = v[2]!;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** Rotation taking unit direction `from` onto unit direction `to`. */
export function quatFromTo(from: ArrayLike<number>, to: ArrayLike<number>): Quat {
  const d = from[0]! * to[0]! + from[1]! * to[1]! + from[2]! * to[2]!;
  if (d < -0.999999) {
    // opposite: rotate 180 degrees around any perpendicular axis
    const ax = Math.abs(from[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const c = cross(from, ax);
    return quatAxisAngle(c, 180);
  }
  const c = cross(from, to);
  return quatNormalize([c[0], c[1], c[2], 1 + d]);
}

export function cross(a: ArrayLike<number>, b: ArrayLike<number>): V3 {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

export function normalize3(v: ArrayLike<number>): V3 {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

/** Mirrors a bone rotation across the character's YZ plane (left <-> right). */
export function quatMirrorX(q: ArrayLike<number>): Quat {
  return [q[0]!, -q[1]!, -q[2]!, q[3]!];
}

/** Quaternion -> Euler degrees (XYZ order). */
export function quatToEuler(q: ArrayLike<number>): V3 {
  const [x, y, z, w] = q as Quat;
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - z * w);
  const m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  let ex: number;
  let ez: number;
  if (Math.abs(m13) < 0.9999999) {
    ex = Math.atan2(-m23, m33);
    ez = Math.atan2(-m12, m11);
  } else {
    ex = Math.atan2(m32, m22);
    ez = 0;
  }
  return [ex / D2R, ey / D2R, ez / D2R];
}
