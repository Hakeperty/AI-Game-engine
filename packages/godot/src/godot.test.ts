import { createSceneDoc, type Entity, localMatrix, parseComponent } from '@aige/core';
import { describe, expect, it } from 'vitest';
import { assemblyName, materialTres, projectGodot } from './project.ts';
import { type SceneExportContext, sceneToTscn } from './scene.ts';
import { color, format, strings, TscnWriter, transform3d, vec3 } from './tscn.ts';

const ctx: SceneExportContext = {
  model: () => ({
    res: 'res://godot/models/bed-abc.glb',
    bounds: { min: [-0.5, 0, -1], max: [0.5, 0.6, 1] },
    collider: null,
  }),
  material: () => null,
  scriptBase: (p) => (p.endsWith('Player.cs') ? 'CharacterBody3D' : 'Node3D'),
  audio: (a) => (a.ambience ? `res://godot/audio/ambience/${a.ambience}.ogg` : null),
};

function entity(name: string, components: object[], extra: object = {}): Entity {
  return {
    id: `id_${name}`,
    name,
    parent: null,
    active: true,
    tags: [],
    transform: { position: [0, 0, 0] as const, rotation: [0, 0, 0] as const, scale: [1, 1, 1] as const },
    components: components.map((c) => parseComponent(c)),
    ...extra,
  };
}

describe('tscn writer', () => {
  it('formats values like Godot', () => {
    expect(format(1.5)).toBe('1.5');
    expect(format(1 / 3)).toBe('0.333333');
    expect(format('a "b"')).toBe('"a \\"b\\""');
    expect(color('#ff8000').text).toBe('Color(1, 0.501961, 0, 1)');
    expect(vec3([1, 2, 3]).text).toBe('Vector3(1, 2, 3)');
    expect(strings(['a', 'b']).text).toBe('PackedStringArray("a", "b")');
  });

  it('writes basis rows (a 90° Y rotation maps +X to -Z)', () => {
    const m = localMatrix({ position: [1, 2, 3], rotation: [0, 90, 0], scale: [1, 1, 1] });
    const parts = transform3d(m.elements)
      .text.replace(/^Transform3D\(|\)$/g, '')
      .split(', ')
      .map(Number);
    // row 0 = (x.x, y.x, z.x) = (0, 0, 1); row 2 = (x.z, y.z, z.z) = (-1, 0, 0)
    expect(parts.slice(0, 3).map((v) => Math.round(v))).toEqual([0, 0, 1]);
    expect(parts.slice(6, 9).map((v) => Math.round(v))).toEqual([-1, 0, 0]);
    expect(parts.slice(9)).toEqual([1, 2, 3]);
  });

  it('shares identical sub-resources', () => {
    const w = new TscnWriter();
    const a = w.sub('BoxShape3D', { size: vec3([1, 1, 1]) });
    const b = w.sub('BoxShape3D', { size: vec3([1, 1, 1]) });
    const c = w.sub('BoxShape3D', { size: vec3([2, 1, 1]) });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});

describe('sceneToTscn', () => {
  it('maps entities, bodies, components and the environment', () => {
    const scene = createSceneDoc('house');
    scene.entities = [
      entity(
        'Hero',
        [
          { type: 'CharacterController', height: 1.78, radius: 0.3 },
          { type: 'Script', script: 'builtin:PlayerController', props: { walkSpeed: 1.5 } },
        ],
        { tags: ['Player'] },
      ),
      entity('Bed', [
        { type: 'MeshRenderer', model: 'models/furniture.model.ts' },
        { type: 'Collider', shape: 'auto' },
      ]),
      entity('Photo', [
        {
          type: 'Interactable',
          prompt: 'Look at photo',
          voice: 'hero_photo_1',
          cutscene: 'cutscenes/photo.cutscene.json',
        },
      ]),
      entity('StairsDoor', [{ type: 'Door', locked: true, unlockFlag: 'upstairs' }]),
      entity('Table', [
        { type: 'Collider', shape: 'box', size: [2, 1, 2], isTrigger: true },
        { type: 'Trigger', voice: 'hero_table' },
      ]),
      entity('Bulb', [
        { type: 'Light', kind: 'point', intensity: 2, range: 6, flicker: 0.4, castShadow: true },
      ]),
      entity('Wind', [{ type: 'AudioSource', ambience: 'storm', playOnStart: true }]),
      entity('Look', [{ type: 'Environment', sky: 'storm', fogDensity: 0.02, volumetricFog: 0.03 }]),
      entity('Kid', [{ type: 'Script', script: 'scripts/Player.cs', props: { Speed: 3, Home: [1, 2, 3] } }], {
        parent: 'id_Bed',
      }),
    ];
    const { tscn, warnings, environments } = sceneToTscn(scene, ctx);
    expect(tscn).toMatch(/^\[gd_scene load_steps=\d+ format=3\]/);
    expect(tscn).toContain('[node name="Hero" type="CharacterBody3D" parent="." groups=["Player"]]');
    expect(tscn).toContain('path="res://addons/aige/Builtins/PlayerController.cs"');
    expect(tscn).toContain('WalkSpeed = 1.5');
    expect(tscn).toContain('[node name="Shape" type="CollisionShape3D" parent="Hero"]');
    expect(tscn).toContain('[node name="Mesh" parent="Bed" instance=ExtResource(');
    expect(tscn).toContain('[node name="Body" type="StaticBody3D" parent="Bed"]');
    expect(tscn).toContain('Prompt = "Look at photo"');
    expect(tscn).toContain('Cutscene = "res://cutscenes/photo.cutscene.json"');
    expect(tscn).toContain('[node name="StairsDoor" type="AnimatableBody3D" parent="."]');
    expect(tscn).toContain('UnlockFlag = "upstairs"');
    expect(tscn).toContain('[node name="Area" type="Area3D" parent="Table"]');
    expect(tscn).toContain('type="OmniLight3D" parent="Bulb"');
    expect(tscn).toContain('[node name="Flicker" type="Node" parent="Bulb/Light"]');
    expect(tscn).toContain('Amount = 0.4');
    expect(tscn).toContain('path="res://godot/audio/ambience/storm.ogg"');
    expect(tscn).toContain('[node name="Environment" type="WorldEnvironment" parent="."]');
    expect(environments[0]!.path).toBe('godot/environments/house-Look.tres');
    expect(environments[0]!.tres).toContain('volumetric_fog_enabled = true');
    expect(environments[0]!.tres).toContain('metadata/aige_fx');
    expect(tscn).toContain('path="res://godot/environments/house-Look.tres"');
    expect(tscn).toContain('[node name="Kid" type="CharacterBody3D" parent="Bed"]');
    expect(tscn).toContain('Home = Vector3(1, 2, 3)');
    expect(tscn).toContain('metadata/aige_id = "id_Photo"');
    expect(warnings).toEqual([]);
  });

  it('flags TypeScript scripts and missing environments', () => {
    const scene = createSceneDoc('x');
    scene.entities = [entity('A', [{ type: 'Script', script: 'scripts/a.ts' }])];
    const { warnings } = sceneToTscn(scene, ctx);
    expect(warnings.some((w) => w.includes('C#'))).toBe(true);
    expect(warnings.some((w) => w.includes('Environment'))).toBe(true);
  });
});

describe('project files', () => {
  it('names the assembly and writes autoloads + input map', () => {
    expect(assemblyName('The Quiet Harbour')).toBe('QuietHarbour');
    const p = projectGodot({
      title: 'The Quiet Harbour',
      assembly: 'QuietHarbour',
      mainScene: 'res://godot/scenes/house.tscn',
    });
    expect(p).toContain('Story="*res://addons/aige/Story.cs"');
    expect(p).toContain('interact={');
    expect(p).toContain('3d/physics_engine="Jolt Physics"');
  });

  it('uses ORMMaterial3D for packed maps', () => {
    const tres = materialTres({
      format: 'aige.material',
      version: 1,
      color: '#ffffff',
      metalness: 1,
      roughness: 1,
      emissive: '#000000',
      emissiveIntensity: 1,
      opacity: 1,
      map: 'textures/a_diff.jpg',
      mapRepeat: [0.5, 0.5],
      normalMap: 'textures/a_nor.jpg',
      normalScale: 1,
      ormMap: 'textures/a_arm.jpg',
      aoIntensity: 1,
      heightMap: 'textures/a_disp.png',
      heightScale: 0.05,
      vertexColors: false,
      flatShading: false,
      doubleSided: false,
      alphaCutoff: 0,
    });
    expect(tres).toMatch(/^\[gd_resource type="ORMMaterial3D"/);
    expect(tres).toContain('orm_texture = ExtResource(');
    expect(tres).toContain('uv1_scale = Vector3(0.5, 0.5, 1)');
    expect(tres).toContain('heightmap_enabled = true');
    expect(tres).toContain('heightmap_scale = 5');
  });
});
