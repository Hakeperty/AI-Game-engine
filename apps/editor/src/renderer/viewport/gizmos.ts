import type { Entity } from '@aige/core';
import {
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Line,
  LineBasicMaterial,
  LineSegments,
  type Object3D,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
} from 'three';
import { PATHS } from '../ui/iconPaths.ts';

const spriteMaterials = new Map<string, SpriteMaterial>();

/** A round badge with an icon glyph, drawn once per kind (Unity-style gizmo icon). */
function iconMaterial(icon: string, color: string, selected = false): SpriteMaterial {
  const key = `${icon}|${color}|${selected}`;
  let m = spriteMaterials.get(key);
  if (m) return m;
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  ctx.fillStyle = selected ? 'rgba(242,163,58,0.95)' : 'rgba(22,23,27,0.82)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = selected ? '#ffd9a0' : color;
  ctx.stroke();
  const path = new Path2D(PATHS[icon] ?? PATHS.light!);
  ctx.save();
  ctx.translate(size * 0.2, size * 0.2);
  ctx.scale((size * 0.6) / 24, (size * 0.6) / 24);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = selected ? '#1b1206' : color;
  ctx.stroke(path);
  ctx.restore();
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  m = new SpriteMaterial({
    map: tex,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    sizeAttenuation: false,
    toneMapped: false,
  });
  spriteMaterials.set(key, m);
  return m;
}

const lineMaterial = new LineBasicMaterial({
  color: '#e8d9a0',
  transparent: true,
  opacity: 0.55,
  toneMapped: false,
  depthWrite: false,
});
const cameraLineMaterial = new LineBasicMaterial({
  color: '#cfd6e6',
  transparent: true,
  opacity: 0.6,
  toneMapped: false,
  depthWrite: false,
});

function frustumLines(fov: number, aspect: number, near: number, far: number): LineSegments {
  const t = Math.tan((fov * Math.PI) / 360);
  const corners = (d: number) => {
    const h = t * d;
    const w = h * aspect;
    return [
      [-w, -h, -d],
      [w, -h, -d],
      [w, h, -d],
      [-w, h, -d],
    ];
  };
  const n = corners(near);
  const f = corners(far);
  const pts: number[] = [];
  const seg = (a: number[], b: number[]) => pts.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!);
  for (let i = 0; i < 4; i++) {
    seg(n[i]!, n[(i + 1) % 4]!);
    seg(f[i]!, f[(i + 1) % 4]!);
    seg([0, 0, 0], f[i]!);
  }
  // "up" triangle on the far plane
  const h = t * far;
  seg([-h * 0.3, h * 1.08, -far], [0, h * 1.35, -far]);
  seg([0, h * 1.35, -far], [h * 0.3, h * 1.08, -far]);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pts, 3));
  const l = new LineSegments(g, cameraLineMaterial);
  l.userData.noPick = true;
  return l;
}

function directionLine(length: number): Line {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, -length], 3));
  const l = new Line(g, lineMaterial);
  l.userData.noPick = true;
  return l;
}

/** Adds editor-only helpers (icons, camera frustum, light direction) to an entity's object. */
export function addGizmos(obj: Object3D, e: Entity, selected = false): void {
  for (const c of [...obj.children]) if (c.userData.editorGizmo) obj.remove(c);
  const add = (o: Object3D) => {
    o.userData.editorGizmo = true;
    o.renderOrder = 10;
    obj.add(o);
  };
  for (const c of e.components) {
    if (c.type === 'Light') {
      const kind = String(c.kind ?? 'directional');
      const icon =
        kind === 'directional' ? 'sun' : kind === 'hemisphere' || kind === 'ambient' ? 'globe' : 'light';
      const sprite = new Sprite(iconMaterial(icon, '#f5d76e', selected));
      sprite.scale.set(0.05, 0.05, 1);
      add(sprite);
      if (kind === 'directional' || kind === 'spot') add(directionLine(kind === 'directional' ? 2 : 1.5));
    } else if (c.type === 'Camera') {
      const sprite = new Sprite(iconMaterial('camera', '#cfd6e6', selected));
      sprite.scale.set(0.05, 0.05, 1);
      add(sprite);
      add(frustumLines(Number(c.fov ?? 60), 16 / 9, 0.25, 1.6));
    } else if (c.type === 'AudioSource') {
      const sprite = new Sprite(iconMaterial('audio', '#8fd1ff', selected));
      sprite.scale.set(0.04, 0.04, 1);
      add(sprite);
    }
  }
}

export function hasIconGizmo(e: Entity): boolean {
  return e.components.some((c) => c.type === 'Light' || c.type === 'Camera' || c.type === 'AudioSource');
}
