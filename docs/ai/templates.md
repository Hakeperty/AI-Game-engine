# Model templates
Use model_from_template. Parameters show defaults.

- blob-character: Round blob creature with feet, little arms and big eyes. Faces +Z, stands on y = 0.
  params: height=1.2, body="#58b83a", belly="#d9f2b4", eyes="#ffffff", pupils="#1d1d1f", resolution=72
- bush: Leafy shrub made of soft, lumpy foliage clumps with optional berries or flowers. Sits on y = 0.
  params: height=0.9, width=1.3, leaves="#2f7f28", leaves2="#7dbb45", clumps=9, extras="berries" (none|berries|flowers), extraColor="#d6283a"
- cactus: Ribbed saguaro cactus with arms, spines, optional flower and pot. Base on y = 0.
  params: height=1.4, arms=2, color="#3f8f3a", ribs=12, flower=true, flowerColor="#ff5fa2", pot=false
- coin: Collectible coin with rim and star emboss. Stands upright facing +Z, centered at the origin.
  params: radius=0.4, thickness=0.08, color="#ffc83d", emboss="star" (star|none)
- crate: Wooden crate with a frame and recessed panels. Base sits at y = 0.
  params: size=1, wood="#b07a45", frame="#7a4f2a"
- creature: Cute four-legged critter (fox/dog/cat-like) built from smooth SDF chains, with ears, tail and cartoon eyes. Faces +Z, stands on y = 0.
  params: height=0.9, fur="#cf5f17", belly="#fbe9cf", iris="#4a2f1b", ears="pointy" (pointy|round|floppy), tail="fluffy" (fluffy|thin|none), spots=false, legLength=1, chubby=1
- door: Paneled wooden door with a frame and a brass knob. Base at y = 0, hinge on the left (-X).
  params: width=1.2, height=2.2, wood="#8a5a33", frame="#9a9a9a"
- fish: Stylized fish (clownfish, trout, goldfish...) with forked tail, fins and patterns. Faces +Z, bottom on y = 0.
  params: length=0.6, body="#f07a1a", belly="#ffe3c2", fins="#ff9a3d", pattern="stripes" (stripes|spots|plain), patternColor="#fbfbf5", chubby=1
- flag: Waving flag on a pole (level goal / checkpoint). The cloth points toward +X.
  params: height=3, cloth="#e53935", pole="#d9d9d9", waves=1.5
- flower: Single flower (daisy, tulip or poppy) with curved stem, leaves, petals and seed center. Base on y = 0.
  params: height=0.6, style="daisy" (daisy|tulip|poppy), petals=14, petalColor="#ffffff", centerColor="#f2b705", stemColor="#4c8a2e"
- gem: Faceted crystal gem: pointed bottom, flat crown on top. Rests on y = 0.
  params: size=0.5, facets=8, color="#36c5f0", glow=0.35
- island-terrain: Island terrain slab (beach, grass, rock, snow bands) with sea plane, trees and rocks. Usable as a level; sea level y = 0.
  params: size=9, height=1.8, resolution=80, trees=6, rocks=5, water=true, waterColor="#2e8fd0", snow=false
- key: Collectible key standing upright: ring at the top, teeth at the bottom. Centered at the origin.
  params: length=0.6, color="#ffc83d"
- mushroom: Toadstool / forest mushroom (or a small cluster) with spotted domed cap and gills. Base on y = 0.
  params: height=0.6, cap="#c41e1a", stem="#f1e8d6", spots=true, spotColor="#fff8ec", style="toadstool" (toadstool|porcini|tall), count=1
- platform: Platformer block with grass on top. The walkable top is at y = 0; the body hangs below it.
  params: width=4, depth=4, height=1, grass="#62b04e", dirt="#8b5a33"
- rock: Faceted rock or boulder. Change seed for a different shape.
  params: size=1, lumpiness=0.25, color="#8a8f94"
- slime: Glossy cartoon slime (drop or round blob) with puddle drips, eyes and a carved mouth. Faces +Z, sits on y = 0.
  params: height=0.8, color="#2fb34f", shape="drop" (drop|round), mood="happy" (happy|surprised|grumpy), drips=5
- snake: Slithering snake (or segmented cartoon worm) on the ground in an S-curve with raised head. Faces +Z, on y = 0.
  params: length=1.6, style="snake" (snake|worm), color="#4d9a34", pattern="#e2c43a", belly="#efe7b8", wiggles=1.5, thickness=1
- spike: Hazard: grid of metal spikes on a plate. Use a trigger collider and damage the player on touch.
  params: size=1, count=3, spikeHeight=0.5, color="#b8bec6"
- tentacle: Octopus/kraken tentacle rising from the ground and curling at the tip, with suction cups. Base on y = 0.
  params: height=1.5, curl=1, color="#8e3fb8", suckers="#f2b3c8", spots=true, thickness=1
- torch: Wooden torch with an emissive flame. Add a point Light at the flame socket for real light.
  params: height=1, flame="#ffb020", wood="#6b4a2f"
- tree-organic: Seeded organic tree with curvy branching wood and a canopy (cloud, blobs or leaves). Change seed for a new tree. Base on y = 0.
  params: height=4, levels=3, foliage="cloud" (cloud|blobs|leaves|none), leaves="#4a9a34", bark="#6b4a2f", gnarl=0.35, spread=38, droop=0
- tree: Low-poly tree. style "round" = leafy blobs, "pine" = stacked cones. Change seed for variation.
  params: height=3, style="round" (round|pine), leaves="#4f9d3a", bark="#6b4a2f"
