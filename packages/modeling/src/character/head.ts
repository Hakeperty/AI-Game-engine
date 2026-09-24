/**
 * Anatomical head for the character generator: cranium, brow ridge, orbits with eyelids, nose, lips, jaw,
 * cheekbones and ears as smooth-blended signed distance fields, plus separate eyeballs.
 * Designed in "head space" (meters for a 0.232 m head, origin at the chin, +Z forward) and mapped to the
 * character with `HeadFrame`.
 */
import { clamp, DEG, type RGB, smoothstep, type V3 } from '../math.ts';
import { PolyMesh } from '../polymesh.ts';
import { type Sdf, Sdf as SdfClass, sdf } from '../sdf.ts';
import type { Anatomy, HeadShape } from './anatomy.ts';

/** Placement of head space in the model: world = origin + p * scale. */
export interface HeadFrame {
  origin: V3;
  scale: number;
}

/** Facial feature placement (head space) shared by the head SDF, eyes, hair and skin weights. */
export interface FaceLayout {
  eyeL: V3;
  eyeR: V3;
  eyeRadius: number;
  /** y of the mouth line. */
  mouthY: number;
  /** z of the lips' front. */
  lipZ: number;
  noseTip: V3;
  browY: number;
  /** Hairline height at the forehead center. */
  hairlineY: number;
  /** Ear center (left). */
  earL: V3;
  /** Half width of the cranium. */
  craniumHalf: number;
  /** Cranium ellipsoid (center, radii) used by hair. */
  cranium: { c: V3; r: V3 };
}

export interface HeadOptions {
  shape: HeadShape;
  /** 0 child .. 1 adult. */
  maturity: number;
  /** 0 male .. 1 female. */
  fem: number;
}

export function headFrame(an: Anatomy): HeadFrame {
  return { origin: [0, an.y.chin, 0.006 * an.s], scale: an.hh / 0.232 };
}

export const toWorld = (f: HeadFrame, p: V3): V3 => [
  f.origin[0] + p[0] * f.scale,
  f.origin[1] + p[1] * f.scale,
  f.origin[2] + p[2] * f.scale,
];

/** Face layout in head space. */
export function faceLayout(o: HeadOptions): FaceLayout {
  const child = 1 - o.maturity;
  // children: eyes a little lower relative to the head and set in a smaller face
  const eyeY = 0.116 - 0.008 * child;
  const faceZ = 1 - 0.06 * child;
  const wide = o.shape === 'round' ? 1.04 : o.shape === 'long' ? 0.965 : o.shape === 'square' ? 1.02 : 1;
  return {
    eyeL: [0.0315 * wide, eyeY, 0.0685 * faceZ],
    eyeR: [-0.0315 * wide, eyeY, 0.0685 * faceZ],
    eyeRadius: 0.0118 + 0.0004 * child,
    mouthY: 0.0445 + 0.004 * child,
    lipZ: 0.097 * faceZ,
    noseTip: [0, 0.08 + 0.004 * child, 0.104 * faceZ - 0.004 * child],
    browY: 0.126 - 0.004 * child,
    hairlineY: 0.19 - 0.005 * child,
    earL: [0.072 * wide, 0.098, -0.014],
    craniumHalf: 0.075 * wide,
    cranium: { c: [0, 0.145, -0.02], r: [0.075 * wide, 0.094, 0.096] },
  };
}

/** Ellipsoid rotated by Euler degrees around its own center. */
function ell(r: V3, c: V3, rot?: V3): Sdf {
  const e = sdf.ellipsoid(r, [0, 0, 0]);
  return (rot ? e.rotate(rot) : e).translate(c);
}

const sym = (make: (side: 1 | -1) => Sdf): Sdf[] => [make(1), make(-1)];

/** Braincase, forehead and occipital masses (head space); hair is built on the same shapes. */
export function skullParts(L: FaceLayout, o: HeadOptions, grow = 0): Sdf[] {
  const child = 1 - o.maturity;
  const [cx, cy, cz] = L.cranium.c;
  const [rx, ry, rz] = L.cranium.r;
  return [
    ell([rx + grow, ry + grow, rz + grow], [cx, cy, cz]),
    // forehead (frontal bone): narrower and more upright than the braincase
    ell([rx * 0.86 + grow, 0.085 + grow, 0.062 + grow], [0, 0.16, 0.03 - 0.004 * child]),
    // occipital bulge
    ell([rx * 0.8 + grow, 0.062 + grow, 0.05 + grow], [0, 0.126, -0.074]),
  ];
}

/**
 * The head (and upper neck) skin SDF in head space. Separate eyeballs sit in the eye sockets
 * (see `eyeballs`).
 */
export function headSdf(o: HeadOptions, L: FaceLayout): Sdf {
  const child = 1 - o.maturity;
  const fem = o.fem;
  // adult male features (brow ridge, heavy jaw) develop late: an 18-year-old is only partway there
  const masc = ((1 - fem) * Math.max(0, o.maturity - 0.4)) / 0.6;
  const shape = o.shape;
  const jawW = shape === 'square' ? 1.1 : shape === 'round' ? 1.06 : shape === 'long' ? 0.95 : 1;
  const faceLen = shape === 'long' ? 1.05 : shape === 'round' ? 0.97 : 1;
  const er = L.eyeRadius;
  const eyeY = L.eyeL[1];
  const ez = L.eyeL[2];

  // --- skull masses
  const skull = skullParts(L, o);
  // --- face: one mid-face mass, a tapering jaw, the chin, subtle cheekbones and a defined jaw line
  const cheekY = 0.099 - 0.004 * child;
  const jx = 0.046 * jawW - 0.003 * fem + 0.004 * child;
  const face: Sdf[] = [
    ell([0.055, 0.048 * faceLen, 0.05], [0, 0.084, 0.044 - 0.004 * child]),
    ell([0.045 * jawW + 0.003 * child, 0.04 * faceLen, 0.048], [0, 0.038, 0.03 - 0.003 * child]),
    ell(
      [0.021 * (shape === 'square' ? 1.2 : 1) - 0.002 * fem, 0.017, 0.018],
      [0, 0.015, 0.076 * faceLen - 0.005 * child],
    ),
    ...sym((s) =>
      ell([0.017, 0.011 + 0.003 * child, 0.02], [s * 0.047, cheekY, 0.052 + 0.003 * fem], [0, s * 20, 0]),
    ),
    // jaw line (angle of the mandible to the chin) and ramus
    ...sym((s) =>
      sdf.capsule(
        [s * jx, 0.044 - 0.004 * child, -0.02],
        [s * 0.021, 0.012, 0.058 * faceLen],
        0.0095 + 0.002 * masc,
      ),
    ),
    ...sym((s) => ell([0.011, 0.03, 0.02], [s * (jx - 0.001), 0.062, -0.022])),
    // youthful cheek fat pads
    ...sym((s) => ell([0.018, 0.019, 0.017], [s * 0.038, 0.071, 0.064])),
    // mouth mound (teeth arch)
    ell([0.024, 0.022, 0.021], [0, 0.047, 0.066 - 0.003 * child]),
  ];
  // brow ridge
  const browR = 0.0075 + 0.003 * masc;
  const brow = sdf.chain(
    [
      [-0.052, L.browY - 0.005, 0.064],
      [-0.028, L.browY, 0.081 - 0.003 * child],
      [0, L.browY - 0.003, 0.085 - 0.004 * child],
      [0.028, L.browY, 0.081 - 0.003 * child],
      [0.052, L.browY - 0.005, 0.064],
    ],
    browR,
  );
  let head = sdf.smoothUnionAll([...skull, ...face], 0.02).smoothUnion(brow, 0.01);
  // temples and the hollow under the cheekbones (less on children)
  for (const s of [1, -1]) {
    head = head.smoothSubtract(ell([0.011, 0.024, 0.026], [s * 0.078, 0.122, 0.03]), 0.012);
  }

  // eye orbits (soft hollows under the brow, around the eyeball)
  for (const s of [1, -1]) {
    head = head.smoothSubtract(ell([0.016, 0.01, 0.009], [s * 0.032, eyeY + 0.001, ez + 0.011]), 0.006);
  }

  // --- nose
  const nt = L.noseTip;
  const noseScale = (1 - 0.18 * child) * (1 - 0.08 * fem);
  const nose = sdf.smoothUnionAll(
    [
      sdf.roundCone(
        [0, L.browY - 0.012, 0.081],
        [0, nt[1] + 0.009, nt[2] - 0.006],
        0.0058,
        0.0072 * noseScale,
      ),
      ell([0.0085 * noseScale, 0.0085 * noseScale, 0.0082 * noseScale], [0, nt[1], nt[2] - 0.0045]),
      ...sym((s) =>
        ell([0.0055, 0.0056, 0.0075].map((v) => v * noseScale) as V3, [
          s * 0.0118 * noseScale,
          nt[1] - 0.0055,
          nt[2] - 0.0125,
        ]),
      ),
      ell([0.0055, 0.004, 0.009], [0, nt[1] - 0.0075, nt[2] - 0.008]),
    ],
    0.0065,
  );
  head = head.smoothUnion(nose, 0.0065);
  // nostrils
  for (const s of [1, -1]) {
    head = head.smoothSubtract(
      ell([0.0026, 0.0016, 0.0034], [s * 0.0064 * noseScale, nt[1] - 0.0098, nt[2] - 0.0098], [18, 0, 0]),
      0.002,
    );
  }

  // --- lips
  const my = L.mouthY;
  const lz = L.lipZ;
  const lipFull = 1 + 0.25 * fem + 0.1 * child;
  const lips = sdf.smoothUnionAll(
    [
      // upper lip with a cupid's bow
      ell([0.0175, 0.0046 * lipFull, 0.0056], [0, my + 0.0045, lz - 0.0042]),
      ...sym((s) => ell([0.0085, 0.0042 * lipFull, 0.005], [s * 0.0052, my + 0.0062, lz - 0.0045])),
      // lower lip
      ell([0.0155, 0.0058 * lipFull, 0.006], [0, my - 0.0054, lz - 0.006]),
    ],
    0.003,
  );
  head = head.smoothUnion(lips, 0.004);
  // mouth line and corners
  head = head.smoothSubtract(ell([0.0205, 0.0011, 0.012], [0, my, lz + 0.002]), 0.0012);
  for (const s of [1, -1])
    head = head.smoothSubtract(sdf.sphere(0.0022, [s * 0.0205, my, lz - 0.008]), 0.002);
  // philtrum and chin-lip fold
  head = head.smoothSubtract(
    sdf.capsule([0, my + 0.011, lz + 0.0005], [0, nt[1] - 0.012, lz + 0.0005], 0.0021),
    0.002,
  );
  head = head.smoothSubtract(ell([0.015, 0.0035, 0.006], [0, my - 0.016, lz - 0.007]), 0.003);

  // --- eyelids (partial shells around the eyeball) and the eyeball seat
  for (const s of [1, -1]) {
    const c: V3 = [s * L.eyeL[0], eyeY, ez];
    // lids are ~3.5 mm thick; the upper one covers the top of the iris (relaxed, slightly tired look)
    const shell = sdf.sphere(er + 0.0035, c);
    const upper = shell.intersect(sdf.box([0.05, 0.03, 0.04], [c[0], eyeY + 0.0024 + 0.015, c[2] + 0.004]));
    const lower = shell.intersect(sdf.box([0.05, 0.03, 0.04], [c[0], eyeY - 0.005 - 0.015, c[2] + 0.004]));
    head = head.smoothUnion(upper.union(lower).rotate([0, 0, s * -4], c), 0.0025);
    // upper-lid crease
    head = head.smoothSubtract(
      sdf.capsule(
        [c[0] - s * 0.009, eyeY + 0.0095, c[2] + 0.004],
        [c[0] + s * 0.011, eyeY + 0.0088, c[2] + 0.001],
        0.0012,
      ),
      0.0014,
    );
    head = head.subtract(sdf.sphere(er + 0.0005, c));
  }

  // --- ears
  for (const s of [1, -1]) {
    const e = L.earL;
    const c: V3 = [s * e[0], e[1], e[2]];
    const ear = ell([0.0065, 0.03, 0.0185], [0, 0, 0])
      .smoothUnion(sdf.sphere(0.0072, [0, -0.024, 0.003]), 0.006)
      .smoothSubtract(ell([0.0045, 0.012, 0.009], [0.0062, -0.004, 0.003]), 0.0025)
      .smoothSubtract(ell([0.003, 0.016, 0.004], [0.0058, 0.008, -0.008]), 0.002)
      .smoothUnion(sdf.capsule([-0.001, -0.006, 0.012], [-0.001, 0.01, 0.013], 0.0035), 0.003);
    const placed = (s > 0 ? ear : ear.mirrorX().intersect(sdf.box([0.05, 0.1, 0.06], [-0.025, 0, 0])))
      .rotate([-12, s * -7, 0])
      .translate(c);
    head = head.smoothUnion(placed, 0.004);
  }
  return head;
}

/**
 * Skin color of the face/head in head space: redder cheeks, nose, ears and lips, cooler under the eyes,
 * painted eyebrows and a dark lash line on the lids. `base` is the sRGB skin tone.
 */
export function faceColor(
  L: FaceLayout,
  o: HeadOptions,
  colors: { skin: RGB; brow: RGB; lips: RGB; stubble: number },
) {
  const { skin, brow, lips } = colors;
  const red: RGB = [skin[0] * 1.02, skin[1] * 0.86, skin[2] * 0.84];
  const cool: RGB = [skin[0] * 0.9, skin[1] * 0.86, skin[2] * 0.9];
  const er = L.eyeRadius;
  return (p: V3, out: RGB): void => {
    const [x, y, z] = p;
    const ax = Math.abs(x);
    let c: RGB = [skin[0], skin[1], skin[2]];
    const blend = (col: RGB, t: number) => {
      if (t <= 0) return;
      const k = clamp(t, 0, 1);
      c = [c[0] + (col[0] - c[0]) * k, c[1] + (col[1] - c[1]) * k, c[2] + (col[2] - c[2]) * k];
    };
    // cheeks
    const dc = Math.hypot((ax - 0.046) / 0.024, (y - 0.078) / 0.022, (z - 0.066) / 0.03);
    blend(red, 0.45 * (1 - smoothstep(0.4, 1.2, dc)));
    // nose tip / alae
    const dn = Math.hypot(x / 0.016, (y - L.noseTip[1]) / 0.012, (z - L.noseTip[2]) / 0.016);
    blend(red, 0.5 * (1 - smoothstep(0.3, 1.1, dn)));
    // ears
    const de = Math.hypot((ax - L.earL[0]) / 0.018, (y - L.earL[1]) / 0.034, (z - L.earL[2]) / 0.024);
    blend(red, 0.45 * (1 - smoothstep(0.5, 1.1, de)));
    // under the eyes: slightly cool and darker
    const du = Math.hypot(
      (ax - Math.abs(L.eyeL[0])) / 0.014,
      (y - (L.eyeL[1] - 0.011)) / 0.0055,
      (z - (L.eyeL[2] + 0.008)) / 0.02,
    );
    blend(cool, 0.28 * (1 - smoothstep(0.4, 1.2, du)));
    // stubble shadow (jaw, chin, upper lip)
    if (colors.stubble > 0) {
      const jaw =
        y < L.mouthY + 0.02 && z > -0.02 && y > -0.02 ? 1 - smoothstep(0.004, 0.02, y - L.mouthY - 0.004) : 0;
      const lipGap = 1 - smoothstep(0.0, 0.01, Math.abs(y - L.mouthY) - 0.004);
      const cheekLimit = smoothstep(0.075, 0.03, ax + Math.max(0, 0.03 - z) * 0.4);
      blend(
        [skin[0] * 0.72, skin[1] * 0.72, skin[2] * 0.76],
        colors.stubble * jaw * (1 - lipGap * 0.8) * cheekLimit,
      );
    }
    // lips
    const lipU = Math.hypot(x / 0.021, (y - (L.mouthY + 0.005)) / 0.0062, (z - L.lipZ) / 0.012);
    const lipL = Math.hypot(x / 0.0185, (y - (L.mouthY - 0.0056)) / 0.0068, (z - L.lipZ) / 0.012);
    blend(lips, 0.85 * (1 - smoothstep(0.75, 1.05, Math.min(lipU, lipL))));
    // eyebrows: arched band above each eye
    const bx = ax - 0.011;
    if (bx > -0.004 && bx < 0.05 && z > 0.05) {
      const u = clamp(bx / 0.044, 0, 1);
      const arch = L.browY + 0.0015 + 0.005 * Math.sin(Math.PI * Math.min(1, u * 1.25)) - 0.004 * u * u;
      const thick = 0.0042 * (1 - 0.55 * u) + 0.0016;
      const t = 1 - smoothstep(thick * 0.6, thick, Math.abs(y - arch));
      const ends = smoothstep(-0.004, 0.003, bx) * (1 - smoothstep(0.042, 0.05, bx));
      blend(brow, 0.9 * t * ends);
    }
    // lash line along the lid margins
    for (const e of [L.eyeL, L.eyeR]) {
      const dx = x - e[0];
      const dy = y - e[1];
      const dz = z - e[2];
      const r = Math.hypot(dx, dy, dz);
      if (r < er + 0.0045 && dz > 0) {
        const upperM = Math.abs(dy - 0.0024 + dx * dx * 22);
        const lowerM = Math.abs(dy + 0.005 - dx * dx * 18);
        const edge = Math.abs(dx) < er * 0.95 ? 1 : 0;
        blend(brow, edge * 0.7 * (1 - smoothstep(0.0004, 0.0013, upperM)));
        blend(
          [brow[0] * 1.4, brow[1] * 1.3, brow[2] * 1.3],
          edge * 0.3 * (1 - smoothstep(0.0004, 0.001, lowerM)),
        );
      }
    }
    void o;
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
  };
}

/**
 * Two eyeballs (sclera, iris with a darker limbal ring, pupil, slight corneal bulge) in head space, looking
 * forward (+Z). Poles face forward so the iris gets dense rings.
 */
export function eyeballs(L: FaceLayout, iris: RGB, scale: number, origin: V3): PolyMesh {
  const meshes: PolyMesh[] = [];
  for (const e of [L.eyeL, L.eyeR]) {
    meshes.push(
      eyeball(L.eyeRadius, iris).mapPositions((p) => [
        origin[0] + (e[0] + p[0]) * scale,
        origin[1] + (e[1] + p[1]) * scale,
        origin[2] + (e[2] + p[2]) * scale,
      ]),
    );
  }
  return PolyMesh.merge(...meshes);
}

function eyeball(r: number, iris: RGB): PolyMesh {
  const seg = 22;
  // polar angle samples (0 = front pole), dense around the iris
  const thetas = [0, 4, 8, 10.5, 14, 18, 22, 26, 30, 33, 37, 44, 54, 66, 80, 96, 114, 134, 157, 180].map(
    (d) => d * DEG,
  );
  const irisA = 30 * DEG;
  const pupilA = 10.5 * DEG;
  const pts: V3[] = [];
  const cols: RGB[] = [];
  const sclera: RGB = [0.8, 0.76, 0.71];
  const irisDark: RGB = [iris[0] * 0.55, iris[1] * 0.55, iris[2] * 0.55];
  for (let i = 0; i < thetas.length; i++) {
    const th = thetas[i]!;
    // corneal bulge over the iris
    const bulge = th < irisA ? 0.045 * r * Math.cos((th / irisA) * (Math.PI / 2)) ** 2 : 0;
    const rr = r + bulge;
    const ring = i === 0 || i === thetas.length - 1 ? 1 : seg;
    for (let k = 0; k < ring; k++) {
      const ph = (k / seg) * Math.PI * 2;
      pts.push([rr * Math.sin(th) * Math.cos(ph), rr * Math.sin(th) * Math.sin(ph), rr * Math.cos(th)]);
      let c: RGB;
      if (th <= pupilA + 1e-6) c = [0.03, 0.03, 0.035];
      else if (th < irisA - 1e-6) {
        const u = (th - pupilA) / (irisA - pupilA);
        const fleck = 0.9 + 0.2 * Math.sin(ph * 17 + i * 3);
        const lim = smoothstep(0.7, 1, u);
        c = [
          (iris[0] * fleck * (1 - lim) + irisDark[0] * lim) * (0.85 + 0.3 * (1 - u)),
          (iris[1] * fleck * (1 - lim) + irisDark[1] * lim) * (0.85 + 0.3 * (1 - u)),
          (iris[2] * fleck * (1 - lim) + irisDark[2] * lim) * (0.85 + 0.3 * (1 - u)),
        ];
      } else {
        // sclera, slightly pinker toward the corners
        const pink = smoothstep(40 * DEG, 90 * DEG, th) * 0.5;
        c = [sclera[0], sclera[1] - 0.06 * pink, sclera[2] - 0.07 * pink];
      }
      cols.push(c);
    }
  }
  const idx = (i: number, k: number) => {
    if (i === 0) return 0;
    if (i === thetas.length - 1) return pts.length - 1;
    return 1 + (i - 1) * seg + (k % seg);
  };
  const faces: number[][] = [];
  for (let i = 0; i < thetas.length - 1; i++) {
    for (let k = 0; k < seg; k++) {
      if (i === 0) faces.push([0, idx(1, k), idx(1, k + 1)]);
      else if (i === thetas.length - 2) faces.push([idx(i, k), idx(i + 1, 0), idx(i, k + 1)]);
      else faces.push([idx(i, k), idx(i + 1, k), idx(i + 1, k + 1), idx(i, k + 1)]);
    }
  }
  const m = PolyMesh.fromPolygons(pts, faces, 'eye');
  for (const f of m.f) {
    f.c = f.v.map((v) => cols[v]!);
    f.sm = true;
  }
  return m;
}

/**
 * Children's faces are smaller relative to the cranium: compresses everything below the eye line toward it by
 * 1/a (smoothly, no crease). `unwarp` maps a warped head-space point back to design space (for colors/weights).
 */
export function childFaceWarp(maturity: number, eyeY: number) {
  const a = 1 + 0.15 * (1 - maturity);
  const Y = (y: number) => {
    const d = eyeY - y;
    if (d <= 0) return y;
    return eyeY - d * (1 + (a - 1) * smoothstep(0, 0.03, d));
  };
  return {
    a,
    warp(shape: Sdf): Sdf {
      if (a <= 1.0001) return shape;
      const f = shape.f;
      const dc = shape.dc;
      return new SdfClass(
        (x, y, z) => f(x, Y(y), z) / a,
        shape.bounds,
        null,
        shape.lip,
        dc ? (x, y, z, out) => dc(x, Y(y), z, out) / a : null,
      );
    },
    unwarp: (p: V3): V3 => [p[0], Y(p[1]), p[2]],
  };
}
