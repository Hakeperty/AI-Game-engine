import { defineModel, model, p, plants } from 'aige/model';

/**
 * Organic tree grown from a seeded branching skeleton: curvy tapered branches (L-system-lite) and a soft,
 * lumpy canopy (or low-poly clumps / individual leaves) at the branch tips. Base at y = 0.
 */
export default defineModel({
  name: 'tree-organic',
  description:
    'Seeded organic tree with curvy branching wood and a canopy (cloud, blobs or leaves). Change seed for a new tree. Base on y = 0.',
  params: {
    height: p.number(4, { min: 0.3, max: 40, description: 'Approximate total height (m)' }),
    levels: p.int(3, { min: 1, max: 4, description: 'Branching depth' }),
    foliage: p.choice(['cloud', 'blobs', 'leaves', 'none'], 'cloud'),
    leaves: p.color('#4a9a34'),
    bark: p.color('#6b4a2f'),
    gnarl: p.number(0.35, { min: 0, max: 1, description: 'How twisty the branches are' }),
    spread: p.number(38, { min: 10, max: 80, description: 'Branch angle (degrees)' }),
    droop: p.number(0, { min: -1, max: 1, description: 'Negative = weeping, positive = reaching up' }),
  },
  build({ height, levels, foliage, leaves, bark, gnarl, spread, droop }, { seed }) {
    const trunk = height * 0.45;
    const { wood, leaves: canopy } = plants.tree({
      seed,
      length: trunk,
      radius: trunk * 0.085,
      levels,
      children: [2, 4],
      angle: spread,
      gnarl,
      upward: 0.3 + droop * 0.6,
      lengthRatio: 0.68,
      taper: 0.5,
      foliage: foliage as 'cloud' | 'blobs' | 'leaves' | 'none',
      leafSize: height * (foliage === 'leaves' ? 0.12 : 0.085),
      leafColor: leaves,
      barkColor: bark,
      sides: 9,
    });
    const parts: Record<string, typeof wood> = { wood: wood.material({ roughness: 0.9 }) };
    if (canopy.f.length)
      parts.leaves = canopy.material({ roughness: 0.85, flatShading: foliage === 'blobs' });
    return model(parts).setCollider({
      shape: 'cylinder',
      radius: trunk * 0.09,
      height: trunk,
      offset: [0, trunk / 2, 0],
    });
  },
});
