# Modeling recipes (models/<name>.model.ts)
A recipe is TypeScript that builds a mesh from code. Import everything from 'aige/model'.

```ts
import { defineModel, p, box, cylinder, sphere, lathe, roundedBox, extrudeShape, shapes, sdf, model, curves, tube } from 'aige/model';

export default defineModel({
  name: 'lamp',
  params: { height: p.number(1.5, { min: 0.5, max: 3 }), shade: p.color('#f2d38a') },
  build({ height, shade }, { rng }) {
    const base = cylinder({ radius: 0.25, height: 0.06, segments: 32 }).translate([0, 0.03, 0]).material({ color: '#333333', metalness: 0.8, roughness: 0.4 });
    const pole = cylinder({ radius: 0.025, height }).translate([0, height / 2, 0]).material({ color: '#333333', metalness: 0.8 });
    const lampShade = lathe([[0.12, 0], [0.3, -0.25], [0.3, -0.27], [0.1, 0.02]], { segments: 32 })
      .translate([0, height + 0.1, 0]).material({ color: shade, roughness: 0.9, doubleSided: true, emissive: shade, emissiveIntensity: 0.4 });
    return model({ base: base.merge(pole), shade: lampShade }).socket('light', [0, height, 0]);
  },
});
```

## Primitives (all centered at the origin unless noted)
- box({ size: 1 | [x,y,z], center }): faces 'top','bottom','front'(+z),'back','left','right'
- roundedBox({ size, radius, segments }): segments 1 = chamfer. Face groups as box, plus 'bevel'.
- plane({ size: [w, d], segments }): XZ plane facing +Y
- cylinder({ radius, radiusTop, height, segments }): 'side','top','bottom'
- cone({ radius, height, segments }), capsule({ radius, height }), torus({ radius, tube }): flat in XZ
- sphere({ radius, segments, rings }), icosphere({ radius, detail: 0..5 })
- lathe(profile [[r, y], ...] bottom→top, { segments, angle }): vases, bottles, coins, bowls
- extrudeShape(outline [[x, z], ...], { depth, holes, bevel }): shape extruded up along +Y
  - shapes.circle(r, n), shapes.rect(w, h, radius), shapes.star(points, outer, inner), shapes.polygon(n, r)
- sweep(profile2D, path3D, { scale, twist, closed }), tube(path, radius)
  - curves.catmullRom(points), curves.arc(r, a0, a1), curves.helix(r, h, turns), curves.line(a, b)

## Mesh methods (each returns a new mesh, so you can chain them)
- translate([x,y,z]), rotate([x,y,z] deg, pivot?), scale(s | [x,y,z]), center(), placeOnGround(y = 0), mirror('x'), flipAxis('x'), flip(), merge(...meshes)
- extrude(sel, distance, { scale, individual, direction }), inset(sel, amount), subdivide(levels, { smooth })
- displace({ amount, scale, seed, ridged }), jitter(amount), inflate(d), twist(degPerMeter), taper(start, end), bend(deg), spherize(t)
- repeat(count, offset), radial(count, { axis }), union(...), subtract(...), intersect(...): booleans need closed solids
- material({ color, metalness, roughness, emissive, emissiveIntensity, opacity, flatShading, doubleSided, texture }, sel?)
- color('#hex', sel?), gradient('y', from, to), colorBy((p, n) => '#hex'), smooth(bool), flat(), group(name, sel)
- uvBox(scale), uvPlanar('y'), uvCylindrical(), uvSpherical()
- bounds(), validate()

## Selectors (sel)
- 'top' (a face group), ['top', 'front'], or { normal: '+y', minDot: 0.7 }
- { within: { min, max } }, { above: y }, or a function (face) => boolean

## Organic modeling (creatures, plants, rocks, slimes, terrain)
Sculpt with signed distance fields (SDF): combine shapes with smooth unions, color them, then call .mesh(). SDF meshes are always watertight and manifold. Meshing takes about 0.1 to 0.7 s.

```ts
// models/critter.model.ts
import { defineModel, eye, model, p, sdf } from 'aige/model';

export default defineModel({
  name: 'critter',
  params: { height: p.number(0.8, { min: 0.2, max: 5 }), fur: p.color('#c8622a'), belly: p.color('#f6e2c4') },
  build({ height, fur, belly }, { seed }) {
    const legs = [];
    for (const x of [-0.1, 0.1])
      for (const z of [0.14, -0.16])
        legs.push(sdf.chain([[x, 0.36, z], [x * 1.1, 0.18, z + 0.02], [x * 1.1, 0.04, z + 0.03]], [0.07, 0.055, 0.05]));
    const shape = sdf
      .smoothUnionAll(
        [
          sdf.ellipsoid([0.2, 0.18, 0.3], [0, 0.38, 0]), // body first (fastest)
          sdf.sphere(0.18, [0, 0.6, 0.26]), // head
          sdf.ellipsoid([0.08, 0.06, 0.08], [0, 0.54, 0.42]), // snout
          ...legs,
          sdf.chain([[0, 0.42, -0.28], [0, 0.55, -0.45], [0, 0.72, -0.42]], (t) => 0.04 + 0.04 * Math.sin(Math.PI * t)), // tail
          sdf.roundCone([0.1, 0.72, 0.22], [0.15, 0.86, 0.2], 0.05, 0.012).mirrorX(), // ears
        ],
        0.07,
      )
      .color(fur)
      .colorByNormal(belly, '-y', 0.2) // light belly and chin
      .colorSpots('#6b3a1e', { scale: 9, size: 0.25, seed })
      .cutBelow(0, 0.01); // flat paws on y = 0
    const s = height / 0.88;
    const eyes = [-1, 1].map((side) =>
      eye({ radius: 0.05, iris: '#3b2414' }).rotate([0, side * 16, 0]).translate([side * 0.08, 0.64, 0.4]),
    );
    return model({
      body: shape.mesh({ detail: 'high', decimate: 12000, ao: 0.6 }).scale(s).material({ roughness: 0.7 }),
      eyes: eyes[0].merge(eyes[1]).scale(s).material({ roughness: 0.15 }),
    });
  },
});
```

SDF shapes:
- sdf.sphere(r, center), sdf.ellipsoid([rx, ry, rz], c), sdf.box(size, c, round), sdf.capsule(a, b, r, rb?), sdf.cylinder(r, h), sdf.torus(R, r), sdf.cone(r, h)
- sdf.roundCone(a, b, ra, rb): an exact tapered capsule. Use it for horns, claws, snouts and fingers.
- sdf.chain(points, radii | [r per point] | (t) => r, { curve: true, smooth }): a smooth spline tube for limbs, tails, necks, worms, tentacles and branches.
- sdf.tube(path, r | (t) => r): follows curves.helix / curves.catmullRom output.
- sdf.metaballs([{ center, radius, color? }, ...], threshold 0.5): goo that melts together.
- sdf.smoothUnionAll([body, head, ...legs], k): the fastest way to build big creatures. Put the body first.

Operators (each returns a new Sdf):
- Booleans: .smoothUnion(o, k), .union, .subtract, .smoothSubtract(o, k) (carve mouths and sockets), .intersect
- Transforms: .translate, .rotate(deg, pivot?), .scale(s), .stretch([sx, sy, sz]), .mirror('x') / .mirrorX()
- .twist(degPerMeter, axis) and .bend(degPerMeter): bend curls +Y toward +X, so build the part upright, then rotate it.
- .elongate([hx, hy, hz]), .round(r), .shell(t), .onion(t) (hollow, keeps the outside)
- .warp(amount, scale, seed): noise domain warp. Makes shapes look natural and hand-made.
- .displace(amount, scale, seed): bumps.
- .displaceBy(p => meters, maxMeters): custom ribs, rings and grooves.
- .cutBelow(y, k) / .cutAbove(y, k): flat bottoms that stand on the ground. Use k > 0 for a rounded edge.

Colors:
- .color('#hex'), .gradient('y', from, to, range?)
- .colorBy(([x, y, z], base) => '#hex')
- .colorByNoise([c1, c2], scale, seed): patches.
- .colorSpots(c, { scale, size, seed })
- .stripes([c1, c2], { direction: 'z', width, wobble })
- .colorByNormal(c, '-y', threshold): belly, underside or back.

.mesh({ detail: 'low' | 'medium' (default) | 'high' | 'ultra', resolution?, smooth: 2, decimate: 12000 | 0.5, ao: true | 0.6, colorSmooth: 1 })
- decimate is a triangle target or a ratio.
- ao bakes ambient occlusion into the vertex colors.
- Thin parts (fins, ears, petals) must be at least 2 cells thick, where one cell is the model size divided by the resolution. Use detail 'high' for them.

Mesh ops (on any mesh):
- .smoothMesh({ iterations }): Taubin smoothing that preserves volume.
- .relax()
- .brush({ center, radius, mode: 'inflate' | 'grab' | 'pinch' | 'flatten' | 'smooth' | 'noise', strength, direction })
- .decimate(n | ratio), .bakeAO({ strength }), .repairManifold()

Helpers:
- eye({ radius, iris, pupil, irisSize, pupilSize }): a crisp cartoon eye that looks along +Z. Keep eyes as a separate part.
- terrain({ size, resolution, height: number | (x, z) => y, island, slab, noise: { scale, ridged, warp }, colors, seed }): a level heightfield with sand, grass, rock and snow colors.
  - terrainHeight(sameOpts)(x, z) returns the surface height, for placing props.
- plants.tree({ length, levels, foliage: 'cloud' | 'blobs' | 'leaves', leafColor, barkColor, seed }) returns { wood, leaves }.
  - Lower-level parts: plants.branches(opts), plants.branchMesh(branches), plants.leaf({ shape: 'leaf' | 'round' | 'blade' }), plants.leaves(points, leafMesh).

Organic templates: creature, slime, fish, mushroom, bush, flower, cactus, snake (or worm), tentacle, tree-organic, island-terrain, blob-character.

## Tips
- Keep triangle counts modest (under 20k per prop). Lower segments, or use .mesh({ decimate }) for SDF models.
- flatShading: true gives a low-poly look. Use vertex colors (color/gradient) for cheap variety.
- Return model({ partA, partB }).socket('hand', [x, y, z]).setCollider({ shape: 'capsule', radius, height, offset }) for rich models.
- Use params for anything a level designer might tweak; entities override them with MeshRenderer.params.
