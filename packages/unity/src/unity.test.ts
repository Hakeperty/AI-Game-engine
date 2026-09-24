import { type ComponentData, createSceneDoc, type Entity } from '@aige/core';
import { Euler, Quaternion } from 'three';
import { describe, expect, it } from 'vitest';
import {
  colliderToUnity,
  eulerXyzToQuaternion,
  manifestJson,
  metaFile,
  packageVersions,
  patchProjectSettings,
  portGodotScript,
  rotate,
  sceneToUnity,
  toUnityQuaternion,
  toUnityRotation,
  toUnityVector,
  toUnityYaw,
  type UnitySceneContext,
  unityGuid,
} from './index.ts';

const close = (a: readonly number[], b: readonly number[], eps = 1e-5) =>
  a.forEach((v, i) => {
    expect(Math.abs(v - b[i]!)).toBeLessThan(eps);
  });
const cross = (a: readonly number[], b: readonly number[]) => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sub = (a: readonly number[], b: readonly number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const norm = (a: readonly number[]) => {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!);
  return [a[0]! / l, a[1]! / l, a[2]! / l];
};

describe('coordinates', () => {
  it('mirrors X like glTFast', () => {
    expect(toUnityVector([1, 2, 3])).toEqual([-1, 2, 3]);
    expect(toUnityQuaternion([0.1, 0.2, 0.3, 0.9])).toEqual([0.1, -0.2, -0.3, 0.9]);
    expect(toUnityYaw(30)).toBe(-30);
    expect(toUnityVector([0, 0, 0])).toEqual([0, 0, 0]); // no negative zero
    expect(Object.is(toUnityVector([0, 1, 1])[0], -0)).toBe(false);
  });

  it('matches three.js XYZ Euler order', () => {
    for (const e of [
      [10, 20, 30],
      [-50.4, -44.4, 0],
      [0, 180, 0],
      [95, -12, 170],
    ]) {
      const q = new Quaternion().setFromEuler(
        new Euler(...(e.map((d) => (d * Math.PI) / 180) as [number, number, number]), 'XYZ'),
      );
      const mine = eulerXyzToQuaternion(e);
      const sign = Math.sign(mine[3]) === Math.sign(q.w) ? 1 : -1;
      close(mine, [q.x * sign, q.y * sign, q.z * sign, q.w * sign]);
    }
  });

  it('keeps rotations consistent with positions (asymmetric case)', () => {
    // AIGE: an entity at [1, 2, 3] turned 90° around Y faces world +X (models face +Z).
    const rot = [0, 90, 0];
    const facingAige = rotate(eulerXyzToQuaternion(rot), [0, 0, 1]);
    close(facingAige, [1, 0, 0]);
    // Unity: the same entity faces Unity -X, which is AIGE +X mirrored.
    close(rotate(toUnityRotation(rot), [0, 0, 1]), [-1, 0, 0]);
    // Any rotation: rotate-then-convert equals convert-then-rotate.
    for (const e of [
      [10, 20, 30],
      [-50.4, -44.4, 0],
      [33, 150, -70],
    ])
      for (const v of [
        [1, 0, 0],
        [0.3, -2, 5],
      ])
        close(
          rotate(toUnityRotation(e), toUnityVector(v)),
          toUnityVector(rotate(eulerXyzToQuaternion(e), v)),
          1e-4,
        );
  });

  it('does not mirror the rendered image', () => {
    // Kitchen shot: camera at [2, 1.6, 0.9] looking at [4, 0.9, -2.8]; a point to the camera's right in AIGE
    // must be to the camera's right in Unity too.
    const cam = [2, 1.6, 0.9];
    const target = [4, 0.9, -2.8];
    const up = [0, 1, 0];
    const fwdA = norm(sub(target, cam));
    const rightA = norm(cross(fwdA, up)); // three.js: right-handed, camera looks down -Z
    const fwdU = norm(sub(toUnityVector(target), toUnityVector(cam)));
    const rightU = norm(cross(up, fwdU)); // Unity: Quaternion.LookRotation(forward, up) * Vector3.right
    for (const p of [
      [4.73, 1, -3.3], // fridge
      [0, 1, -3],
      [5, 0, 0],
    ]) {
      const xA = dot(sub(p, cam), rightA);
      const xU = dot(sub(toUnityVector(p), toUnityVector(cam)), rightU);
      expect(Math.sign(xU)).toBe(Math.sign(xA));
      expect(xU).toBeCloseTo(xA, 5);
    }
  });
});

describe('scene mapping', () => {
  const ctx: UnitySceneContext = {
    model: () => ({
      asset: 'Assets/AigeData/models/table-1.gltf',
      bounds: { min: [-1, 0, -0.5], max: [1, 0.8, 0.5] },
    }),
    material: (p) => `Assets/AigeData/materials/${p.split('/').pop()!.replace('.material.json', '.json')}`,
    audio: (a) => (a.ambience ? `Assets/Resources/aige/ambience/${a.ambience}.ogg` : null),
    texture: (p) => `Assets/AigeData/textures/${p}`,
    script: (p) =>
      p === 'scripts/Chapter1.cs' ? { name: 'Chapter1', path: 'Assets/Scripts/Chapter1.cs' } : null,
  };
  const entity = (
    id: string,
    name: string,
    components: ComponentData[],
    extra: Partial<Entity> = {},
  ): Entity => ({
    id,
    name,
    parent: null,
    active: true,
    tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components,
    ...extra,
  });

  it('converts transforms, meshes, colliders, lights, components and scripts', () => {
    const scene = createSceneDoc('house');
    scene.entities.push(
      entity('e1', 'Kitchen', []),
      entity(
        'e2',
        'Table',
        [
          { type: 'MeshRenderer', model: 'models/furniture.model.ts', castShadow: true, visible: true },
          { type: 'Collider', shape: 'auto', offset: [0.5, 0, 0], isTrigger: false },
          {
            type: 'Interactable',
            prompt: 'Examine',
            range: 1.4,
            setFlag: 'saw_table',
            requireFlag: undefined,
          },
        ],
        {
          parent: 'e1',
          tags: ['Furniture'],
          transform: { position: [4, 0, -2.8], rotation: [0, 90, 0], scale: [1, 1, 1] },
        },
      ),
      entity('e3', 'Lamp', [
        { type: 'Light', kind: 'point', intensity: 0.9, range: 0, flicker: 0.3, castShadow: true },
      ]),
      entity('e4', 'Milch', [
        { type: 'CharacterController', height: 1.78, radius: 0.28 },
        { type: 'Script', script: 'builtin:PlayerController', props: { walkSpeed: 1.5 }, enabled: true },
        { type: 'Script', script: 'builtin:Nope', props: {}, enabled: true },
      ]),
      entity('e5', 'Story', [{ type: 'Script', script: 'scripts/Chapter1.cs', props: {}, enabled: true }]),
      entity('e6', 'Night', [
        {
          type: 'Environment',
          sunDirection: [-0.4, 0.45, -0.8],
          hdri: 'textures/hdri/moon.hdr',
          hdriRotation: 140,
        },
      ]),
      entity('e7', 'Storm', [{ type: 'AudioSource', ambience: 'storm', volume: 0.5, playOnStart: true }]),
    );
    const { doc, warnings } = sceneToUnity(scene, ctx);
    expect(doc.format).toBe('aige.unity.scene');
    const table = doc.entities.find((e) => e.name === 'Table')!;
    expect(table.parent).toBe('e1');
    expect(table.position).toEqual([-4, 0, -2.8]);
    close(table.rotation, toUnityRotation([0, 90, 0]));
    expect(table.mesh).toMatchObject({ model: 'Assets/AigeData/models/table-1.gltf', castShadow: true });
    // bounds center (0, 0.4, 0) + offset (0.5, 0, 0), mirrored on X
    expect(table.colliders![0]).toMatchObject({ shape: 'box', center: [-0.5, 0.4, 0], size: [2, 0.8, 1] });
    expect(table.components).toEqual([
      { type: 'Interactable', props: { prompt: 'Examine', range: 1.4, setFlag: 'saw_table' } },
    ]);
    expect(doc.entities.find((e) => e.name === 'Lamp')!.light).toMatchObject({
      type: 'point',
      range: 30,
      flicker: 0.3,
    });
    const milch = doc.entities.find((e) => e.name === 'Milch')!;
    expect(milch.character).toMatchObject({ height: 1.78, radius: 0.28, stepHeight: 0.35 });
    expect(milch.scripts).toEqual([{ kind: 'builtin', name: 'PlayerController', props: { walkSpeed: 1.5 } }]);
    expect(warnings.some((w) => w.includes("'Nope'"))).toBe(true);
    expect(doc.entities.find((e) => e.name === 'Story')!.scripts![0]).toMatchObject({
      kind: 'cs',
      name: 'Chapter1',
    });
    const env = doc.entities.find((e) => e.name === 'Night')!.environment!;
    expect(env.sunDirection).toEqual([0.4, 0.45, -0.8]);
    expect(env.hdriRotation).toBe(-140);
    expect(env.hdri).toBe('Assets/AigeData/textures/textures/hdri/moon.hdr');
    expect(doc.mainEnvironment).toBe('Night');
    expect(doc.entities.find((e) => e.name === 'Storm')!.audio![0]).toMatchObject({
      loop: true,
      volume: 0.5,
    });
  });

  it('uses the recipe collider hint and keeps capsules at least 2r tall', () => {
    const hint = colliderToUnity(
      { type: 'Collider', shape: 'auto' },
      { asset: 'x', collider: { shape: 'cylinder', radius: 0.3, height: 0.9, offset: [1, 0.45, 0] } },
    );
    expect(hint).toMatchObject({ shape: 'cylinder', radius: 0.3, height: 0.9, center: [-1, 0.45, 0] });
    expect(
      colliderToUnity({ type: 'Collider', shape: 'capsule', radius: 0.5, height: 0.2 }, null).height,
    ).toBe(1);
  });
});

describe('project files', () => {
  it('reads package versions from the editor manifest', () => {
    const v = packageVersions({ packages: { 'com.unity.cloud.gltfast': { version: '6.20.0' } } });
    expect(v['com.unity.cloud.gltfast']).toBe('6.20.0');
    expect(v['com.unity.render-pipelines.universal']).toBe('17.5.0');
    const m = JSON.parse(manifestJson(v, { 'com.unity.timeline': '1.8.12' }));
    expect(m.dependencies['com.unity.modules.physics']).toBe('1.0.0');
    expect(m.dependencies['com.unity.timeline']).toBe('1.8.12');
  });

  it('patches project settings and makes stable GUIDs', () => {
    const s = patchProjectSettings(
      'x\n  m_ActiveColorSpace: 0\n  activeInputHandler: 0\n  productName: unity\n',
      'The Sidle',
    );
    expect(s).toContain('m_ActiveColorSpace: 1');
    expect(s).toContain('activeInputHandler: 2');
    expect(s).toContain('productName: The Sidle');
    expect(unityGuid('Assets/Aige/Runtime/Story.cs')).toMatch(/^[0-9a-f]{32}$/);
    expect(unityGuid('Assets/Aige/Runtime/Story.cs')).toBe(unityGuid('Assets\\Aige\\Runtime\\Story.cs'));
    expect(metaFile('Assets/Aige', true)).toContain('folderAsset: yes');
  });

  it('ports a Godot game script to a MonoBehaviour', () => {
    const godot = `using Aige;
using Godot;

public partial class Chapter1 : Node3D
{
    [Export] public float PointerDelay = 30f;

    public override void _Ready()
    {
        Story.On("flag:woke_up", () => Story.SetObjective("Look around", "Photo_1", pointerDelay: PointerDelay), this);
        CallDeferred(MethodName.Begin);
    }

    public override void _Process(double delta)
    {
        GD.Print("tick");
    }

    private void Begin() => Animator.Of(Entities.Find("Milch"))?.Play("idle");
}
`;
    const { code, notes } = portGodotScript(godot, 'Chapter1');
    expect(code).toContain('using UnityEngine;');
    expect(code).not.toContain('using Godot;');
    expect(code).toContain('public class Chapter1 : MonoBehaviour');
    expect(code).toContain('public float PointerDelay = 30f;');
    expect(code).toContain('void Start()');
    expect(code).toContain('Invoke(nameof(Begin), 0f)');
    expect(code).toContain('double delta = Time.deltaTime;');
    expect(code).toContain('Debug.Log("tick")');
    expect(code).toContain('AigeAnimator.Of(');
    expect(notes).toEqual([]);
  });
});
