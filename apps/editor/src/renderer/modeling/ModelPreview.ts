import { createSceneDoc } from '@aige/core';
import { SceneRenderer } from '@aige/render';
import {
  type Box3,
  GridHelper,
  type LineBasicMaterial,
  type Material,
  type Mesh,
  MeshNormalMaterial,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { modelCache } from '../three/assets.ts';

export interface ViewFlags {
  wireframe: boolean;
  normals: boolean;
  flat: boolean;
}

/** Studio-look preview of a single model (SceneRenderer.build with studio: true). */
export class ModelPreview {
  private readonly renderer: WebGLRenderer;
  private readonly sr: SceneRenderer;
  private readonly camera = new PerspectiveCamera(35, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly overlay = new Scene();
  private grid: GridHelper | null = null;
  private readonly container: HTMLElement;
  private raf = 0;
  private disposed = false;
  private currentKey: string | null = null;
  private flags: ViewFlags = { wireframe: false, normals: false, flat: false };
  private readonly normalMaterial = new MeshNormalMaterial();
  private framedSize = 0;
  private visible = true;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.className = 'preview-canvas';
    container.appendChild(this.renderer.domElement);
    this.sr = new SceneRenderer(this.renderer, modelCache);
    this.camera.position.set(2, 1.6, 2.4);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.2;
    this.raf = requestAnimationFrame(this.frame);
  }

  async show(key: string): Promise<void> {
    this.currentKey = key;
    const scene = createSceneDoc('preview');
    scene.entities.push({
      id: 'e1',
      name: 'model',
      parent: null,
      active: true,
      tags: [],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [
        { type: 'MeshRenderer', model: 'preview', castShadow: true, receiveShadow: true, visible: true },
      ],
    });
    await this.sr.build(scene, { meshKeys: { e1: key }, materials: {}, studio: true });
    if (this.currentKey !== key) return;
    for (const o of this.sr.objects.values()) {
      o.traverse((m) => {
        const mesh = m as Mesh;
        if (mesh.isMesh) mesh.userData.originalMaterial = mesh.material;
      });
    }
    this.applyFlags();
    this.updateGridAndFrame();
  }

  setFlags(flags: ViewFlags): void {
    this.flags = flags;
    this.applyFlags();
  }

  private applyFlags(): void {
    for (const o of this.sr.objects.values()) {
      o.traverse((m) => {
        const mesh = m as Mesh;
        if (!mesh.isMesh) return;
        const orig = mesh.userData.originalMaterial as Material | Material[] | undefined;
        if (!orig) return;
        if (this.flags.normals) {
          this.normalMaterial.wireframe = this.flags.wireframe;
          this.normalMaterial.flatShading = this.flags.flat;
          this.normalMaterial.needsUpdate = true;
          mesh.material = this.normalMaterial;
          return;
        }
        if (!this.flags.wireframe && !this.flags.flat) {
          mesh.material = orig;
          return;
        }
        const convert = (mat: Material) => {
          const c = mat.clone() as Material & { wireframe?: boolean; flatShading?: boolean };
          if ('wireframe' in c) c.wireframe = this.flags.wireframe;
          if ('flatShading' in c && this.flags.flat) c.flatShading = true;
          c.needsUpdate = true;
          return c;
        };
        mesh.material = Array.isArray(orig) ? orig.map(convert) : convert(orig);
      });
    }
  }

  private updateGridAndFrame(): void {
    const box = this.sr.renderableBounds();
    if (box.isEmpty()) return;
    const size = box.getSize(new Vector3());
    const extent = Math.max(size.x, size.z, 0.5) * 3;
    const step = 10 ** Math.floor(Math.log10(extent / 10));
    const divisions = Math.min(200, Math.max(4, Math.round(extent / step)));
    if (this.grid) this.overlay.remove(this.grid);
    this.grid = new GridHelper(divisions * step, divisions, 0x6b7280, 0x3f4450);
    const gm = this.grid.material as LineBasicMaterial;
    gm.transparent = true;
    gm.opacity = 0.6;
    gm.depthWrite = false;
    this.grid.position.set(0, Math.min(0, box.min.y), 0);
    this.overlay.add(this.grid);
    const s = size.length();
    if (Math.abs(s - this.framedSize) > this.framedSize * 0.5 || this.framedSize === 0) {
      this.frame3d(box);
      this.framedSize = s;
    }
  }

  resetCamera(): void {
    const box = this.sr.renderableBounds();
    if (!box.isEmpty()) this.frame3d(box);
  }

  private frame3d(box: Box3): void {
    const sphere = box.getBoundingSphere(new Sphere());
    const r = Math.max(sphere.radius, 0.05);
    const dist = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.15;
    const dir = new Vector3(1, 0.75, 1.1).normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.001, dist / 200);
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setVisible(v: boolean): void {
    this.visible = v;
  }

  private readonly frame = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (!this.visible || document.hidden || !this.container.isConnected) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const pr = this.renderer.getPixelRatio();
    if (
      this.renderer.domElement.width !== Math.floor(w * pr) ||
      this.renderer.domElement.height !== Math.floor(h * pr)
    ) {
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = `${w}px`;
      this.renderer.domElement.style.height = `${h}px`;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
    this.renderer.autoClear = true;
    this.renderer.render(this.sr.scene, this.camera);
    this.renderer.autoClear = false;
    this.renderer.render(this.overlay, this.camera);
    this.renderer.autoClear = true;
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.sr.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
