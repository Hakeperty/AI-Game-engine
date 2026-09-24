/**
 * Story textures painted procedurally (environmental storytelling for Chapter 1):
 * - textures/story/drawing.png: Murphy's crayon drawing. Milch, Murphy, and the person between them with
 *   the head scribbled out; a triple spiral in the corner, like the one on his shield.
 * - textures/story/calendar.png: the kitchen calendar. The days are crossed off one by one until a date
 *   circled in red; after that nothing, as if time stopped.
 * Writes materials/story_drawing and materials/story_calendar.  Run: node games/sidle-of-milch/build/textures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, createMaterialDoc } from '@aige/core';
import { encodePng } from '@aige/modeling';

const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'textures/story'), { recursive: true });

class Canvas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  private seed = 1;
  constructor(width: number, height: number, paper: [number, number, number]) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const fiber = (this.rand() - 0.5) * 10 + Math.sin(x * 0.7 + y * 0.13) * 2;
        const age = Math.min(1, Math.hypot(x / width - 0.5, y / height - 0.5) * 1.6) * 18; // yellowed edges
        const i = (y * width + x) * 4;
        this.data[i] = clamp(paper[0] + fiber - age * 0.6);
        this.data[i + 1] = clamp(paper[1] + fiber - age * 0.9);
        this.data[i + 2] = clamp(paper[2] + fiber - age * 1.4);
        this.data[i + 3] = 255;
      }
  }
  rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }
  blend(x: number, y: number, c: [number, number, number], a: number) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    for (let k = 0; k < 3; k++) this.data[i + k] = clamp(this.data[i + k]! * (1 - a) + c[k]! * a);
  }
  /** A waxy crayon stroke: several jittered passes with gaps in the texture. */
  crayon(x0: number, y0: number, x1: number, y1: number, c: [number, number, number], w = 3, passes = 3) {
    for (let p = 0; p < passes; p++) {
      const jx = (this.rand() - 0.5) * 2;
      const jy = (this.rand() - 0.5) * 2;
      const len = Math.hypot(x1 - x0, y1 - y0);
      for (let t = 0; t <= len; t += 0.5) {
        const f = len ? t / len : 0;
        const cx = x0 + (x1 - x0) * f + jx;
        const cy = y0 + (y1 - y0) * f + jy;
        for (let k = 0; k < w * 2; k++) {
          if (this.rand() < 0.35) continue; // paper grain shows through the wax
          this.blend(cx + (this.rand() - 0.5) * w, cy + (this.rand() - 0.5) * w, c, 0.55);
        }
      }
    }
  }
  poly(points: [number, number][], c: [number, number, number], w = 3, passes = 3) {
    for (let i = 0; i + 1 < points.length; i++) this.crayon(...points[i]!, ...points[i + 1]!, c, w, passes);
  }
  circle(cx: number, cy: number, r: number, c: [number, number, number], w = 3, turns = 1.05) {
    const pts: [number, number][] = [];
    for (let a = 0; a <= Math.PI * 2 * turns; a += 0.15)
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.95]);
    this.poly(pts, c, w);
  }
  rect(x: number, y: number, w: number, h: number, c: [number, number, number]) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.blend(i, j, c, 1);
  }
  save(rel: string) {
    writeFileSync(resolve(root, rel), encodePng({ width: this.width, height: this.height, data: this.data }));
  }
}
const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

// ---------------------------------------------------------------------------------------------------------
// Murphy's drawing
// ---------------------------------------------------------------------------------------------------------
{
  const cv = new Canvas(512, 384, [238, 232, 214]);
  const green: [number, number, number] = [70, 140, 60];
  const blue: [number, number, number] = [40, 80, 170];
  const red: [number, number, number] = [190, 40, 40];
  const purple: [number, number, number] = [120, 60, 140];
  const black: [number, number, number] = [25, 22, 20];
  const yellow: [number, number, number] = [235, 190, 40];
  // grass
  for (let x = 20; x < 492; x += 9) cv.crayon(x, 330, x + 4, 312 + (x % 17), green, 2, 1);
  cv.crayon(20, 332, 492, 330, green, 3);
  // sun
  cv.circle(440, 60, 26, yellow, 4);
  for (let a = 0; a < 12; a++) {
    const t = (a / 12) * Math.PI * 2;
    cv.crayon(
      440 + Math.cos(t) * 34,
      60 + Math.sin(t) * 34,
      440 + Math.cos(t) * 50,
      60 + Math.sin(t) * 50,
      yellow,
      3,
      2,
    );
  }
  // triple spiral in the corner (the whirl from the shield)
  for (let k = 0; k < 3; k++) {
    const base = -Math.PI / 2 + (k * Math.PI * 2) / 3;
    const cx = 70 + Math.cos(base) * 16;
    const cy = 70 + Math.sin(base) * 16;
    const pts: [number, number][] = [];
    for (let t = 0; t < 1; t += 0.02) {
      const ang = base + Math.PI + t * Math.PI * 4;
      pts.push([cx + Math.cos(ang) * (2 + t * 16), cy + Math.sin(ang) * (2 + t * 16)]);
    }
    cv.poly(pts, black, 2, 2);
  }
  const figure = (x: number, top: number, h: number, c: [number, number, number]) => {
    const head = h * 0.18;
    cv.circle(x, top + head, head, c, 3);
    const neck = top + head * 2;
    cv.crayon(x, neck, x, top + h * 0.62, c, 3); // body
    cv.crayon(x, top + h * 0.62, x - h * 0.12, top + h, c, 3); // legs
    cv.crayon(x, top + h * 0.62, x + h * 0.12, top + h, c, 3);
    return { head: [x, top + head] as const, arms: top + h * 0.35, headR: head };
  };
  // Milch (tall, left), the person in the middle, Murphy (small, right): holding hands
  const milch = figure(150, 150, 180, blue);
  const mid = figure(256, 138, 192, purple);
  const murphy = figure(360, 210, 120, red);
  cv.crayon(150, milch.arms, 256, mid.arms, blue, 3); // hand in hand
  cv.crayon(256, mid.arms, 360, murphy.arms, purple, 3);
  cv.crayon(150, milch.arms, 110, milch.arms + 30, blue, 3);
  cv.crayon(360, murphy.arms, 392, murphy.arms + 22, red, 3);
  // smiles
  cv.crayon(143, milch.head[1] + 8, 157, milch.head[1] + 8, blue, 2, 2);
  cv.crayon(354, murphy.head[1] + 6, 366, murphy.head[1] + 6, red, 2, 2);
  // ...and the middle head scribbled out, hard, in black
  for (let i = 0; i < 70; i++) {
    const a = cv.rand() * Math.PI * 2;
    const r = mid.headR * 1.25;
    cv.crayon(
      mid.head[0] + Math.cos(a) * r * cv.rand(),
      mid.head[1] + Math.sin(a) * r * cv.rand(),
      mid.head[0] + Math.cos(a + 2.4) * r * cv.rand(),
      mid.head[1] + Math.sin(a + 2.4) * r * cv.rand(),
      black,
      4,
      1,
    );
  }
  cv.save('textures/story/drawing.png');
}

// ---------------------------------------------------------------------------------------------------------
// The kitchen calendar
// ---------------------------------------------------------------------------------------------------------
{
  const cv = new Canvas(384, 512, [232, 228, 218]);
  const ink: [number, number, number] = [40, 38, 36];
  const pencil: [number, number, number] = [70, 70, 75];
  const red: [number, number, number] = [180, 30, 30];
  // printed header
  cv.rect(0, 0, 384, 150, [120, 40, 36]);
  for (let y = 18; y < 132; y += 3)
    for (let x = 20; x < 364; x += 3)
      if (Math.sin(x * 0.05) * Math.cos(y * 0.07) > 0.3) cv.blend(x, y, [150, 70, 60], 0.5);
  // seven-segment style printed digits for the day numbers
  const SEG: Record<string, string> = {
    0: 'abcdef',
    1: 'bc',
    2: 'abged',
    3: 'abgcd',
    4: 'fgbc',
    5: 'afgcd',
    6: 'afgedc',
    7: 'abc',
    8: 'abcdefg',
    9: 'abcfgd',
  };
  const digit = (d: string, x: number, y: number, s: number) => {
    const seg: Record<string, [number, number, number, number]> = {
      a: [0, 0, 1, 0],
      b: [1, 0, 1, 1],
      c: [1, 1, 1, 2],
      d: [0, 2, 1, 2],
      e: [0, 1, 0, 2],
      f: [0, 0, 0, 1],
      g: [0, 1, 1, 1],
    };
    for (const k of SEG[d] ?? '') {
      const [a, b, c, e] = seg[k]!;
      const x0 = x + a * s;
      const y0 = y + b * s;
      const x1 = x + c * s;
      const y1 = y + e * s;
      for (let t = 0; t <= 1; t += 0.05)
        cv.rect(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), 2, 2, ink);
    }
  };
  const lastCrossed = 13;
  const circled = 14;
  for (let day = 1; day <= 30; day++) {
    const col = (day + 2) % 7;
    const row = Math.floor((day + 2) / 7);
    const x = 14 + col * 51;
    const y = 170 + row * 64;
    // box lines
    for (let i = 0; i < 49; i++) {
      cv.blend(x + i, y, ink, 0.35);
      cv.blend(x + i, y + 60, ink, 0.35);
    }
    for (let j = 0; j < 60; j++) {
      cv.blend(x, y + j, ink, 0.35);
      cv.blend(x + 48, y + j, ink, 0.35);
    }
    const s = String(day);
    for (const [k, ch] of s.split('').entries()) digit(ch, x + 5 + k * 10, y + 5, 7);
    if (day <= lastCrossed) {
      cv.crayon(x + 6, y + 10, x + 44, y + 54, pencil, 2, 2);
      cv.crayon(x + 44, y + 10, x + 6, y + 54, pencil, 2, 2);
    }
    if (day === circled) {
      cv.circle(x + 24, y + 30, 26, red, 3, 1.25);
      cv.circle(x + 24, y + 31, 24, red, 2, 1.1);
    }
  }
  cv.save('textures/story/calendar.png');
}

for (const [name, map] of [
  ['story_drawing', 'textures/story/drawing.png'],
  ['story_calendar', 'textures/story/calendar.png'],
] as const) {
  writeFileSync(
    resolve(root, `materials/${name}.material.json`),
    canonicalJson(createMaterialDoc({ map, roughness: 0.9 })),
  );
}
console.log('wrote textures/story/drawing.png, calendar.png and their materials');
