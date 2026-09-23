import { z } from 'zod';
import { AssetPath, Color } from './common.ts';
import { defineComponent } from './components.ts';

/**
 * Scene look: filmic tone mapping, exposure, sky, exponential height fog, SSAO, bloom, color grade,
 * vignette and film grain. Put one on any entity (e.g. 'Environment'). Cutscene fx tracks and
 * `Screen.tween('exposure' | 'fog' | 'contrast' ...)` animate on top of these values.
 */
export const Environment = defineComponent({
  type: 'Environment',
  category: 'rendering',
  multiple: false,
  description:
    "Realistic scene look: tone mapping + exposure, sky, exponential height fog, ambient occlusion (SSAO), bloom for bright windows/emissives, color grade (contrast/saturation/temperature/tint), vignette and film grain, plus visible light shafts for spot lights. One per scene. Cutscene fx tracks animate exposure/fog/grade on top. Night storm: {sky:'storm', exposure:0.8, fogDensity:0.04, temperature:-0.35, saturation:0.7, grain:0.25}. Warm morning: {sky:'dawn', exposure:1.15, temperature:0.3, bloom:0.4}.",
  schema: z.object({
    toneMapping: z
      .enum(['project', 'aces', 'agx', 'neutral', 'none'])
      .default('aces')
      .describe("Filmic curve; 'project' uses project render settings"),
    exposure: z.number().min(0.05).max(8).default(1),
    sky: z
      .enum(['none', 'night', 'storm', 'dawn', 'day', 'dusk', 'overcast'])
      .default('none')
      .describe("Procedural sky dome ('none' keeps the scene background color)"),
    sunDirection: z
      .tuple([z.number(), z.number(), z.number()])
      .default([-0.4, 0.45, -0.8])
      .describe('Direction toward the sun/moon glow on the sky'),
    fogColor: Color.default('#1a1f2a'),
    fogDensity: z.number().min(0).max(1).default(0).describe('Exponential fog density per meter (0 = off)'),
    fogHeightFalloff: z
      .number()
      .min(0)
      .max(5)
      .default(0.2)
      .describe('How fast fog thins with height (0 = uniform)'),
    fogBaseHeight: z.number().default(0).describe('Height (m) where fog is densest'),
    ssao: z.number().min(0).max(2).default(0.8).describe('Ambient occlusion strength (0 = off)'),
    ssaoRadius: z.number().positive().max(5).default(0.35).describe('AO radius in meters'),
    bloom: z.number().min(0).max(3).default(0.25).describe('Bloom strength for bright pixels (0 = off)'),
    bloomThreshold: z.number().min(0).max(10).default(0.9),
    contrast: z.number().min(0).max(2).default(1.05),
    saturation: z.number().min(0).max(2).default(1),
    temperature: z.number().min(-1).max(1).default(0).describe('-1 = cold blue, +1 = warm orange'),
    tint: z.number().min(-1).max(1).default(0).describe('-1 = green, +1 = magenta'),
    vignette: z.number().min(0).max(1).default(0.25),
    grain: z.number().min(0).max(1).default(0.12).describe('Film grain amount'),
    hdri: AssetPath.optional().describe(
      "Equirectangular .hdr sky for lighting and reflections (asset_fetch kind 'hdri'); overrides `sky`",
    ),
    hdriRotation: z.number().default(0).describe('Sky rotation around Y in degrees'),
    skyEnergy: z.number().min(0).max(16).default(1).describe('Brightness of the sky/HDRI'),
    ambient: z.number().min(0).max(8).default(1).describe('Ambient (sky) light strength'),
    gi: z
      .enum(['none', 'sdfgi'])
      .default('sdfgi')
      .describe('Real-time global illumination (Godot SDFGI): light bouncing off walls and floors'),
    ssil: z.boolean().default(true).describe('Screen-space indirect light (subtle color bleeding)'),
    autoExposure: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .describe('Eye adaptation: dark rooms slowly brighten, bright ones darken (0 = off)'),
    volumetricFog: z
      .number()
      .min(0)
      .max(1)
      .default(0)
      .describe(
        'Volumetric fog density: visible light beams and haze around lights (0 = off, 0.02 = dusty room)',
      ),
    lightShafts: z
      .number()
      .min(0)
      .max(2)
      .default(0)
      .describe('Visible dusty beams for spot lights (0 = off, 0.5 = subtle)'),
  }),
  example: {
    sky: 'storm',
    exposure: 0.85,
    fogDensity: 0.03,
    temperature: -0.3,
    saturation: 0.75,
    grain: 0.2,
  },
});
