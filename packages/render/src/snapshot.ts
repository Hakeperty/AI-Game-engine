import type { MaterialDoc, ProjectDoc, SceneDoc } from '@aige/core';
import { AxesHelper, Box3, Box3Helper, Color, GridHelper, type Object3D, PerspectiveCamera, Vector3, type WebGLRenderer } from 'three';
import type { ModelCache } from './assets.ts';
import type { SceneRenderer } from './scene-renderer.ts';
import { customCamera, framingCamera, layoutFor, projectToScreen, VIEW_LABELS, type ViewSpec } from './views.ts';

export interface SnapshotRequest {
  width: number;
  height: number;
  views: ViewSpec[];
  scene: SceneDoc;
  project?: Pick<ProjectDoc, 'render'>;
  materials?: Record<string, MaterialDoc>;
  /** model key -> base64 GLB */
  models?: Record<string, string>;
  /** entity id -> model key */
  meshKeys?: Record<string, string>;
  /** texture path -> base64 PNG (for materials with a map) */
  textures?: Record<string, string>;
  overlays?: { grid?: boolean; axes?: boolean; labels?: boolean; bounds?: boolean; dimensions?: boolean };
  /** Entity ids to frame (default: everything visible). */
  focus?: string[];
  studio?: boolean;
  /** Optional title printed in the corner (e.g. model name). */
  title?: string;
}

export interface SnapshotResult {
  png: string;
  width: number;
  height: number;
  views: { label: string; camera: { position: number[]; target: number[] } }[];
  stats: { triangles: number; drawCalls: number; bounds: { min: number[]; max: number[]; size: number[] } };
}

/** Renders one or more labeled views of a scene into a single PNG (a "contact sheet"). */
export async function snapshot(renderer: WebGLRenderer, sr: SceneRenderer, models: ModelCache, req: SnapshotRequest): Promise<SnapshotResult> {
  for (const [key, glb] of Object.entries(req.models ?? {})) if (!models.has(key)) await models.add(key, glb);
  for (const [path, png] of Object.entries(req.textures ?? {})) sr.textures.add(path, png);
  await sr.textures.ready();
  await sr.build(req.scene, {
    meshKeys: req.meshKeys ?? {},
    materials: req.materials ?? {},
    ...(req.project ? { project: req.project } : {}),
    ...(req.studio ? { studio: true } : {}),
  });
  const bounds = sr.renderableBounds(req.focus?.length ? req.focus : undefined);
  const helpers: Object3D[] = [];
  const size = bounds.isEmpty() ? new Vector3(1, 1, 1) : bounds.getSize(new Vector3());
  if (req.overlays?.grid) {
    const extent = Math.max(size.x, size.z, 1) * 2;
    const step = niceStep(extent / 10);
    const divisions = Math.max(2, Math.round(extent / step));
    const grid = new GridHelper(divisions * step, divisions, new Color('#6b7280'), new Color('#3f4450'));
    const c = bounds.isEmpty() ? new Vector3() : bounds.getCenter(new Vector3());
    grid.position.set(c.x, bounds.isEmpty() ? 0 : Math.min(0, bounds.min.y), c.z);
    helpers.push(grid);
  }
  if (req.overlays?.axes) helpers.push(new AxesHelper(Math.max(size.x, size.y, size.z) * 0.6));
  if (req.overlays?.bounds && !bounds.isEmpty()) helpers.push(new Box3Helper(bounds.clone(), new Color('#ffcc00')));
  for (const h of helpers) sr.scene.add(h);

  const { cols, rows } = layoutFor(req.views.length);
  const W = req.width;
  const H = req.height;
  const cw = Math.floor(W / cols);
  const ch = Math.floor(H / rows);
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.setScissorTest(true);
  renderer.setClearColor(sr.scene.background instanceof Color ? sr.scene.background : new Color('#222222'));
  renderer.clear();
  const cameras: PerspectiveCamera[] = [];
  let triangles = 0;
  let drawCalls = 0;
  req.views.forEach((view, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const aspect = cw / ch;
    let cam: PerspectiveCamera;
    if (view.kind === 'camera') {
      const primary = sr.primaryCamera();
      if (primary) {
        cam = primary.clone();
        primary.updateWorldMatrix(true, false);
        cam.matrixWorld.copy(primary.matrixWorld);
        cam.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
        cam.aspect = aspect;
        cam.updateProjectionMatrix();
      } else cam = framingCamera('iso', bounds, aspect);
    } else if (view.kind === 'custom') cam = customCamera(view, aspect);
    else cam = framingCamera(view.kind, bounds, aspect, view.fov ?? 35);
    cameras.push(cam);
    // three's viewport origin is bottom-left
    const y = H - (row + 1) * ch;
    renderer.setViewport(col * cw, y, cw, ch);
    renderer.setScissor(col * cw, y, cw, ch);
    renderer.render(sr.scene, cam);
    triangles += renderer.info.render.triangles;
    drawCalls += renderer.info.render.calls;
  });
  renderer.setScissorTest(false);
  for (const h of helpers) sr.scene.remove(h);

  // Composite + annotate on a 2D canvas.
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(renderer.domElement, 0, 0, W, H);
  ctx.textBaseline = 'top';
  const scale = Math.max(0.75, Math.min(1.6, W / 1024));
  const font = (px: number, weight = 600) => `${weight} ${Math.round(px * scale)}px system-ui, Segoe UI, sans-serif`;
  req.views.forEach((view, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const ox = col * cw;
    const oy = row * ch;
    if (cols > 1 || rows > 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(ox + 0.5, oy + 0.5, cw - 1, ch - 1);
    }
    tag(ctx, view.label ?? VIEW_LABELS[view.kind], ox + 8, oy + 8, font(13, 700), '#ffffff', 'rgba(0,0,0,0.55)');
    if (req.overlays?.labels) {
      const cam = cameras[i]!;
      const drawn: { x: number; y: number }[] = [];
      let count = 0;
      for (const [id, obj] of sr.objects) {
        if (count >= 40) break;
        // Only the entity's own visual (not child entities): group entities get no label.
        const box = new Box3();
        for (const child of obj.children) {
          if (child.userData.entityId || !child.userData.meshRenderer) continue;
          box.expandByObject(child);
        }
        if (box.isEmpty() || box.getSize(new Vector3()).length() > size.length() * 0.9) continue;
        const top = new Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
        const s = projectToScreen(top, cam, cw, ch);
        if (!s.visible) continue;
        if (drawn.some((d) => Math.abs(d.x - s.x) < 60 * scale && Math.abs(d.y - s.y) < 14 * scale)) continue;
        drawn.push(s);
        tag(ctx, `${id} ${obj.name}`, ox + s.x, oy + s.y - 16 * scale, font(11, 600), '#101010', 'rgba(255,221,87,0.85)', true);
        count++;
      }
    }
  });
  const dims = `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} m`;
  if (req.title || req.overlays?.dimensions) {
    const text = [req.title, req.overlays?.dimensions ? dims : ''].filter(Boolean).join('  ·  ');
    ctx.font = font(13, 600);
    const w = ctx.measureText(text).width;
    tag(ctx, text, W - w - 18 * scale, H - 26 * scale, font(13, 600), '#ffffff', 'rgba(0,0,0,0.55)');
  }
  const png = canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
  const b = bounds.isEmpty() ? new Box3(new Vector3(), new Vector3()) : bounds;
  return {
    png,
    width: W,
    height: H,
    views: req.views.map((v, i) => {
      const cam = cameras[i]!;
      const dir = new Vector3();
      cam.getWorldDirection(dir);
      return {
        label: v.label ?? VIEW_LABELS[v.kind],
        camera: { position: cam.position.toArray().map(r3), target: cam.position.clone().add(dir.multiplyScalar(5)).toArray().map(r3) },
      };
    }),
    stats: {
      triangles,
      drawCalls,
      bounds: { min: b.min.toArray().map(r3), max: b.max.toArray().map(r3), size: size.toArray().map(r3) },
    },
  };
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function fmt(n: number): string {
  return n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

function tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, font: string, fg: string, bg: string, center = false): void {
  ctx.font = font;
  const m = ctx.measureText(text);
  const pad = 4;
  const h = Number.parseInt(font.split(' ')[1]!, 10) + pad * 2;
  const w = m.width + pad * 2;
  const left = center ? x - w / 2 : x;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(left, y, w, h, 4);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.fillText(text, left + pad, y + pad);
}
