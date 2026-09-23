import { DoubleSide, Mesh, type PerspectiveCamera, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';

/**
 * Editor ground grid: 1 m minor and 10 m major lines plus red X / blue Z axes, anti-aliased with
 * screen-space derivatives and faded with distance so it never turns into moire at the horizon.
 */
export class EditorGrid extends Mesh<PlaneGeometry, ShaderMaterial> {
  constructor() {
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
      uniforms: {
        uCamera: { value: new Vector3() },
        uFade: { value: 120 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uCamera;
        uniform float uFade;
        varying vec3 vWorld;
        float line(vec2 p, float size) {
          vec2 c = p / size;
          vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
          return 1.0 - min(min(g.x, g.y), 1.0);
        }
        void main() {
          float dist = length(vWorld.xz - uCamera.xz);
          float fade = 1.0 - smoothstep(uFade * 0.3, uFade, dist);
          float minor = line(vWorld.xz, 1.0) * 0.14;
          float major = line(vWorld.xz, 10.0) * 0.3;
          float a = max(minor, major);
          vec3 col = vec3(1.0);
          vec2 fw = fwidth(vWorld.xz) * 1.5;
          float xAxis = 1.0 - min(abs(vWorld.z) / fw.y, 1.0);
          float zAxis = 1.0 - min(abs(vWorld.x) / fw.x, 1.0);
          if (xAxis > 0.02) { col = mix(col, vec3(0.95, 0.35, 0.32), xAxis); a = max(a, xAxis * 0.85); }
          if (zAxis > 0.02) { col = mix(col, vec3(0.32, 0.52, 1.0), zAxis); a = max(a, zAxis * 0.85); }
          a *= fade;
          if (a < 0.004) discard;
          gl_FragColor = vec4(col, a);
        }
      `,
    });
    super(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), material);
    this.userData.noPick = true;
    this.frustumCulled = false;
    this.renderOrder = -1;
    this.position.y = 0.003;
  }

  /** Keeps the grid centered under the camera and scales the fade with the view distance. */
  update(camera: PerspectiveCamera, target: Vector3): void {
    const viewDist = camera.position.distanceTo(target);
    const fade = Math.min(1500, Math.max(40, viewDist * 5 + Math.abs(camera.position.y) * 4));
    this.material.uniforms.uFade!.value = fade;
    (this.material.uniforms.uCamera!.value as Vector3).copy(camera.position);
    const size = fade * 2.2;
    this.scale.set(size, 1, size);
    this.position.x = Math.round(camera.position.x);
    this.position.z = Math.round(camera.position.z);
  }
}
