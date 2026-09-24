/**
 * AIGE ↔ Unity coordinates.
 *
 * AIGE (like three.js and glTF) is right-handed, Y up, meters, Euler degrees applied in XYZ order.
 * Unity is left-handed, Y up. The exporter converts by mirroring the X axis, exactly like glTFast
 * does when it imports a GLB, so baked models, scene transforms and runtime data all agree:
 *
 * - position / direction (x, y, z)  →  (-x, y, z)
 * - quaternion (x, y, z, w)         →  (x, -y, -z, w)
 * - Euler degrees [a, b, c] (XYZ)   →  the quaternion Rx(a) · Ry(-b) · Rz(-c)
 * - yaw around Y (degrees)          →  -yaw
 * - scale                           →  unchanged
 *
 * Model fronts (+Z) stay +Z, so a character's `transform.forward` is where it faces. AIGE cameras
 * and lights look along their entity's -Z; in Unity they sit on a child rotated 180° around Y.
 */

export type V3 = [number, number, number];
export type Quat = [number, number, number, number];

const DEG = Math.PI / 180;
/** Rounds to 6 decimals and removes negative zero, so the output JSON stays small and stable. */
const r = (v: number) => {
  const x = Math.round(v * 1e6) / 1e6;
  return x === 0 ? 0 : x;
};

/** AIGE position or direction → Unity. */
export function toUnityVector(v: readonly number[]): V3 {
  return [r(-(v[0] ?? 0)), r(v[1] ?? 0), r(v[2] ?? 0)];
}

/** AIGE quaternion [x, y, z, w] → Unity quaternion [x, y, z, w]. */
export function toUnityQuaternion(q: readonly number[]): Quat {
  return [r(q[0] ?? 0), r(-(q[1] ?? 0)), r(-(q[2] ?? 0)), r(q[3] ?? 1)];
}

/** Hamilton product a · b (apply b, then a). */
export function mulQuat(a: readonly number[], b: readonly number[]): Quat {
  const [ax, ay, az, aw] = a as Quat;
  const [bx, by, bz, bw] = b as Quat;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Quaternion for a rotation of `deg` degrees around a unit axis. */
export function axisAngle(axis: readonly number[], deg: number): Quat {
  const h = (deg * DEG) / 2;
  const s = Math.sin(h);
  return [(axis[0] ?? 0) * s, (axis[1] ?? 0) * s, (axis[2] ?? 0) * s, Math.cos(h)];
}

/** AIGE Euler degrees (XYZ order, three.js convention) → quaternion in AIGE space. */
export function eulerXyzToQuaternion(e: readonly number[]): Quat {
  return mulQuat(
    mulQuat(axisAngle([1, 0, 0], e[0] ?? 0), axisAngle([0, 1, 0], e[1] ?? 0)),
    axisAngle([0, 0, 1], e[2] ?? 0),
  );
}

/** AIGE Euler degrees → Unity quaternion. */
export function toUnityRotation(eulerDeg: readonly number[]): Quat {
  return toUnityQuaternion(eulerXyzToQuaternion(eulerDeg));
}

/** A yaw angle around +Y in degrees (AIGE) → Unity. */
export const toUnityYaw = (deg: number) => r(-deg);

/** Rotates vector v by quaternion q (the same formula in either handedness). */
export function rotate(q: readonly number[], v: readonly number[]): V3 {
  const [qx, qy, qz, qw] = q as Quat;
  const [vx, vy, vz] = v as V3;
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}
