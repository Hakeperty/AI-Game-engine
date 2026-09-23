/**
 * Entry point of the headless render page. The host bundles this file with esbuild and loads it
 * into a (headless) Chromium page; Node then calls `window.aige.snapshot(request)`.
 */
import { WebGLRenderer } from 'three';
import { ModelCache } from './assets.ts';
import { SceneRenderer } from './scene-renderer.ts';
import { type SnapshotRequest, snapshot } from './snapshot.ts';

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const renderer = new WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
const models = new ModelCache();
const sr = new SceneRenderer(renderer, models);

function gpuInfo(): { renderer: string; vendor: string; webgl2: boolean } {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
    vendor: String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
    webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
  };
}

// serialize renders; three's renderer state is shared
let queue: Promise<unknown> = Promise.resolve();

(window as unknown as { aige: unknown }).aige = {
  ready: true,
  info: gpuInfo,
  snapshot(req: SnapshotRequest) {
    const run = queue.then(() => snapshot(renderer, sr, models, req));
    queue = run.catch(() => undefined);
    return run;
  },
  invalidate(key: string) {
    models.invalidate(key);
  },
};
