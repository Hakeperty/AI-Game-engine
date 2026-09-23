/**
 * Seeded 3D gradient noise (improved Perlin) and fractal helpers. Deterministic for a given seed.
 */
export class Noise {
  private readonly perm = new Uint8Array(512);

  constructor(seed = 1) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let s = seed >>> 0 || 1;
    for (let i = 255; i > 0; i--) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const j = s % (i + 1);
      const t = p[i]!;
      p[i] = p[j]!;
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
  }

  /** Noise in roughly [-1, 1]. */
  noise3(x: number, y: number, z: number): number {
    const P = this.perm;
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    z -= Math.floor(z);
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const A = P[X]! + Y;
    const AA = P[A]! + Z;
    const AB = P[A + 1]! + Z;
    const B = P[X + 1]! + Y;
    const BA = P[B]! + Z;
    const BB = P[B + 1]! + Z;
    return lerp(
      w,
      lerp(
        v,
        lerp(u, grad(P[AA]!, x, y, z), grad(P[BA]!, x - 1, y, z)),
        lerp(u, grad(P[AB]!, x, y - 1, z), grad(P[BB]!, x - 1, y - 1, z)),
      ),
      lerp(
        v,
        lerp(u, grad(P[AA + 1]!, x, y, z - 1), grad(P[BA + 1]!, x - 1, y, z - 1)),
        lerp(u, grad(P[AB + 1]!, x, y - 1, z - 1), grad(P[BB + 1]!, x - 1, y - 1, z - 1)),
      ),
    );
  }

  noise2(x: number, y: number): number {
    return this.noise3(x, y, 0.5);
  }

  /** Fractal Brownian motion: layered noise, roughly [-1, 1]. */
  fbm(x: number, y: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Cellular (Worley) noise: distance to the nearest random feature point, roughly [0, 1.2].
   * One feature point per unit cell, so `worley(p * 5)` gives about 5 spots per meter.
   */
  worley(x: number, y: number, z: number): number {
    const P = this.perm;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const cx = xi + dx;
          const cy = yi + dy;
          const cz = zi + dz;
          const h = P[(P[(P[cx & 255]! + cy) & 255]! + cz) & 255]!;
          const fx = cx + P[h]! / 255 - x;
          const fy = cy + P[(h + 71) & 255]! / 255 - y;
          const fz = cz + P[(h + 151) & 255]! / 255 - z;
          const d = fx * fx + fy * fy + fz * fz;
          if (d < best) best = d;
        }
    return Math.sqrt(best);
  }

  /** Ridged noise in [0, 1] (mountain ridges, cracks). */
  ridged(x: number, y: number, z: number, octaves = 4): number {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.noise3(x * freq, y * freq, z * freq));
      sum += n * n * amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum;
  }
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(t: number, a: number, b: number): number {
  return a + t * (b - a);
}

function grad(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}
