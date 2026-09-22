import { unzlibSync, zlibSync } from 'fflate';
import { clamp, hexToRgb, lerp1 } from './math.ts';
import { Noise } from './noise.ts';

/** RGBA8 image. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Encodes an RGBA image as PNG (works in Node and browsers). */
export function encodePng(img: RgbaImage): Uint8Array {
  const { width, height, data } = img;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const idat = zlibSync(raw, { level: 6 });
  const chunks: [string, Uint8Array][] = [
    ['IHDR', ihdr(width, height)],
    ['IDAT', idat],
    ['IEND', new Uint8Array(0)],
  ];
  const size = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0);
  const out = new Uint8Array(size);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let o = 8;
  const view = new DataView(out.buffer);
  for (const [type, d] of chunks) {
    view.setUint32(o, d.length);
    for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i);
    out.set(d, o + 8);
    view.setUint32(o + 8 + d.length, crc32(out, o + 4, o + 8 + d.length));
    o += 12 + d.length;
  }
  return out;
}

function ihdr(w: number, h: number): Uint8Array {
  const b = new Uint8Array(13);
  const v = new DataView(b.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  b[8] = 8; // bit depth
  b[9] = 6; // RGBA
  return b;
}

/** Decodes 8-bit RGBA/RGB PNGs (non-interlaced). Enough to read back our own renders. */
export function decodePng(bytes: Uint8Array): RgbaImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat: Uint8Array[] = [];
  while (o < bytes.length) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(o + 8);
      height = view.getUint32(o + 12);
      colorType = data[9]!;
      if (data[8] !== 8 || data[12] !== 0)
        throw new Error('decodePng: only 8-bit non-interlaced PNGs are supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const total = idat.reduce((n, d) => n + d.length, 0);
  const joined = new Uint8Array(total);
  let p = 0;
  for (const d of idat) {
    joined.set(d, p);
    p += d.length;
  }
  const raw = unzlibSync(joined);
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error('decodePng: only RGB/RGBA PNGs are supported');
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = cur[x * bpp]!;
      out[(y * width + x) * 4 + 1] = cur[x * bpp + 1]!;
      out[(y * width + x) * 4 + 2] = cur[x * bpp + 2]!;
      out[(y * width + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3]! : 255;
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

export type TextureKind = 'checker' | 'noise' | 'grid' | 'bricks' | 'stripes' | 'dots' | 'wood' | 'marble';

/** Generates a tileable procedural texture (colors are '#rrggbb'). */
export function proceduralTexture(opts: {
  kind: TextureKind;
  colorA?: string;
  colorB?: string;
  scale?: number;
  size?: number;
  seed?: number;
}): RgbaImage {
  const size = opts.size ?? 256;
  const scale = opts.scale ?? 4;
  const a = hexToRgb(opts.colorA ?? '#ffffff');
  const b = hexToRgb(opts.colorB ?? '#808080');
  const noise = new Noise(opts.seed ?? 7);
  const data = new Uint8Array(size * size * 4);
  const periodic = (u: number, v: number, freq: number) => {
    // tileable noise via 4D-ish torus mapping on 3D noise
    const s = u * Math.PI * 2;
    const t = v * Math.PI * 2;
    return noise.fbm(Math.cos(s) * freq, Math.sin(s) * freq + Math.cos(t) * freq, Math.sin(t) * freq, 4);
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let t = 0;
      switch (opts.kind) {
        case 'checker':
          t = (Math.floor(u * scale) + Math.floor(v * scale)) % 2;
          break;
        case 'noise':
          t = clamp(periodic(u, v, scale * 0.5) * 0.9 + 0.5, 0, 1);
          break;
        case 'grid': {
          const gu = (u * scale) % 1;
          const gv = (v * scale) % 1;
          t = gu < 0.06 || gv < 0.06 ? 1 : 0;
          break;
        }
        case 'bricks': {
          const rows = scale;
          const row = Math.floor(v * rows);
          const bu = (u * rows * 0.5 + (row % 2) * 0.5) % 1;
          const bv = (v * rows) % 1;
          t = bu < 0.05 || bv < 0.1 ? 1 : 0;
          break;
        }
        case 'stripes':
          t = Math.floor(u * scale * 2) % 2;
          break;
        case 'dots': {
          const du = ((u * scale) % 1) - 0.5;
          const dv = ((v * scale) % 1) - 0.5;
          t = Math.hypot(du, dv) < 0.25 ? 1 : 0;
          break;
        }
        case 'wood': {
          const n = periodic(u, v, 2) * 0.3;
          t = (Math.sin((u * scale + n) * Math.PI * 2 * 3) + 1) / 2;
          t = t ** 3;
          break;
        }
        case 'marble': {
          const n = periodic(u, v, scale * 0.5);
          t = (Math.sin((u + v + n * 1.5) * Math.PI * 4) + 1) / 2;
          break;
        }
      }
      const i = (y * size + x) * 4;
      data[i] = Math.round(lerp1(a[0], b[0], t) * 255);
      data[i + 1] = Math.round(lerp1(a[1], b[1], t) * 255);
      data[i + 2] = Math.round(lerp1(a[2], b[2], t) * 255);
      data[i + 3] = 255;
    }
  return { width: size, height: size, data };
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

declare function btoa(s: string): string;
declare function atob(s: string): string;
