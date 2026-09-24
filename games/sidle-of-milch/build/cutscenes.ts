/**
 * Writes the Chapter 1 cutscenes (cutscenes/*.cutscene.json), validated against the AIGE CutsceneDoc schema.
 * Re-run after editing:  node games/sidle-of-milch/build/cutscenes.ts
 * Coordinates match build/house.ts (bedroom NW, kitchen NE, Murphy's room upstairs SE; upper floor at y = 3).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CutsceneDoc, canonicalJson } from '@aige/core';

type V3 = [number, number, number];
const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'cutscenes'), { recursive: true });

const cam = (t: number, position: V3, lookAt: V3, fov = 45, extra: Record<string, unknown> = {}) => ({
  t,
  position,
  lookAt,
  fov,
  ...extra,
});

function write(name: string, doc: Record<string, unknown>) {
  const parsed = CutsceneDoc.parse({ format: 'aige.cutscene', version: 1, name, ...doc });
  writeFileSync(resolve(root, `cutscenes/${name}.cutscene.json`), canonicalJson(parsed));
  const end = Math.max(
    ...parsed.tracks.flatMap((tr) =>
      'keys' in tr
        ? tr.keys.map((k) => k.t)
        : 'clips' in tr
          ? tr.clips.map((c) => c.t)
          : tr.items.map((i) => i.t),
    ),
  );
  console.log(`${name}: ${parsed.tracks.length} tracks, last event at ${end}s`);
}

// CS1 · Waking up. Night, storm. He lies in the empty bed, sits up, remembers Murphy and screams for him.
write('cs1_wake', {
  duration: 21,
  letterbox: true,
  returnControl: true,
  tracks: [
    {
      type: 'event',
      items: [{ t: 0, teleport: { entity: 'Milch', position: [-3.58, 0.08, -2.95], rotation: [0, 90, 0] } }],
    },
    {
      type: 'animation',
      actor: 'Milch',
      clips: [
        { t: 0, clip: 'lie_asleep', loop: true, fade: 0 },
        { t: 4.2, clip: 'sit_up_bed', fade: 0.4 },
        { t: 7.4, clip: 'sit_idle', loop: true, fade: 0.5 },
        { t: 8.8, clip: 'turn_head_left', fade: 0.4 },
        { t: 10.4, clip: 'stand_up', fade: 0.3 },
        { t: 11.8, clip: 'scream', fade: 0.25 },
        { t: 15.8, clip: 'scared_breathing', loop: true, fade: 0.5 },
      ],
    },
    {
      type: 'camera',
      keys: [
        cam(0, [-3.0, 1.5, -1.25], [-4.3, 0.6, -2.3], 40),
        cam(4, [-3.1, 1.4, -1.5], [-4.1, 0.75, -2.5], 38),
        cam(7.4, [-2.35, 1.25, -2.3], [-3.6, 1.0, -2.95], 40, { cut: true }),
        cam(11.6, [-2.5, 1.15, -2.55], [-3.55, 1.5, -2.95], 38, { cut: true }),
        cam(16.2, [-2.0, 1.6, -1.2], [-3.6, 1.1, -2.9], 50, { cut: true }),
        cam(20.5, [-2.2, 1.6, -1.4], [-3.4, 1.1, -2.7], 50),
      ],
    },
    {
      type: 'voice',
      clips: [
        { t: 5.0, line: 'milch_wake_1', actor: 'Milch' },
        { t: 7.6, line: 'milch_wake_2', actor: 'Milch' },
        { t: 10.3, line: 'milch_remember', actor: 'Milch' },
        { t: 12.0, line: 'milch_scream_1', actor: 'Milch' },
        { t: 17.2, line: 'milch_no_answer', actor: 'Milch' },
      ],
    },
    {
      type: 'sound',
      clips: [
        { t: 1.2, sfx: 'thunder_distant', volume: 0.5 },
        { t: 4.4, sfx: 'breath_in', volume: 0.6 },
        { t: 16.0, sfx: 'breath_out', volume: 0.7 },
      ],
    },
    {
      type: 'fx',
      items: [
        { t: 0, effect: 'fade', to: 1, duration: 0 },
        { t: 0.3, effect: 'fade', to: 0, duration: 4 },
        { t: 0, effect: 'blur', to: 0.5, duration: 0 },
        { t: 3.5, effect: 'blur', to: 0, duration: 5 },
        { t: 12.1, effect: 'shake', to: 0.25, duration: 1.5 },
      ],
    },
    {
      type: 'event',
      items: [
        { t: 20.8, teleport: { entity: 'Milch', position: [-3.2, 0, -2.6], rotation: [0, 90, 0] } },
        { t: 20.9, setFlag: 'woke_up' },
      ],
    },
  ],
});

// Photo 1 on the dresser: Milch, Murphy, and someone in between whose face has been torn out.
write('photo_1', {
  duration: 12.5,
  letterbox: true,
  returnControl: true,
  tracks: [
    { type: 'animation', actor: 'Milch', clips: [{ t: 0, clip: 'examine_object', fade: 0.3 }] },
    {
      type: 'camera',
      keys: [
        cam(0, [-2.05, 1.32, -2.2], [-1.62, 1.06, -2.42], 32),
        cam(6, [-1.95, 1.22, -2.36], [-1.62, 1.06, -2.42], 22, { focus: 0.4, aperture: 0.6 }),
      ],
    },
    {
      type: 'voice',
      clips: [
        { t: 0.6, line: 'milch_photo_1', actor: 'Milch' },
        { t: 10.2, line: 'milch_photo_1b', actor: 'Milch' },
      ],
    },
    {
      type: 'fx',
      items: [
        { t: 3, effect: 'desaturate', to: 0.4, duration: 3 },
        { t: 11.5, effect: 'desaturate', to: 0, duration: 1 },
      ],
    },
  ],
});

// CS2 · The hall. He steps out and takes it in: the kitchen doorway, and a closed door to the stairs.
write('cs2_hall', {
  duration: 8,
  letterbox: true,
  returnControl: true,
  tracks: [
    { type: 'animation', actor: 'Milch', clips: [{ t: 0.2, clip: 'look_around', fade: 0.4 }] },
    {
      type: 'camera',
      keys: [
        cam(0, [-0.7, 1.65, 1.6], [-0.9, 1.2, -0.85], 55),
        cam(3, [-0.6, 1.65, 1.4], [1.3, 1.2, 0.55], 55),
        cam(6, [-0.6, 1.65, 1.2], [0.25, 1.3, -3.3], 50),
      ],
    },
    {
      type: 'sound',
      clips: [
        { t: 0.5, sfx: 'creak', volume: 0.5 },
        { t: 3.5, sfx: 'breath_in', volume: 0.5 },
      ],
    },
  ],
});

// CS3 · A weapon. Scared, he searches the drawers for a knife, finds the second photo on the humming fridge;
// thunder cracks and lightning floods the room.
write('cs3_kitchen', {
  duration: 27,
  letterbox: true,
  returnControl: true,
  tracks: [
    {
      type: 'move',
      actor: 'Milch',
      keys: [
        { t: 0, position: [1.9, 0, 0.3], rotation: [0, 180, 0] },
        { t: 2.6, position: [1.8, 0, -2.75], rotation: [0, 180, 0] },
        { t: 13, position: [1.8, 0, -2.75], rotation: [0, 180, 0] },
        { t: 15.5, position: [3.95, 0, -3.15], rotation: [0, 90, 0] },
      ],
    },
    {
      type: 'animation',
      actor: 'Milch',
      clips: [
        { t: 0, clip: 'walk', loop: true, fade: 0.3 },
        { t: 2.6, clip: 'search_drawer', fade: 0.3 },
        { t: 9.4, clip: 'pick_up', fade: 0.3 },
        { t: 13, clip: 'walk', loop: true, fade: 0.3 },
        { t: 15.5, clip: 'examine_object', fade: 0.4 },
        { t: 22.1, clip: 'gasp_startle', fade: 0.1 },
      ],
    },
    {
      type: 'camera',
      keys: [
        cam(0, [2.6, 1.7, 1.1], [1.9, 1.1, -1.5], 55),
        cam(2.8, [2.9, 1.45, -2.2], [1.8, 0.75, -3.35], 42, { cut: true }),
        cam(9.2, [2.6, 1.2, -2.6], [1.7, 0.7, -3.1], 36),
        cam(13.2, [3.2, 1.6, -1.6], [4.4, 1.25, -3.2], 45, { cut: true }),
        cam(16.5, [4.0, 1.45, -2.55], [4.39, 1.3, -3.18], 30),
        cam(22.1, [2.4, 1.7, -0.4], [4.2, 1.2, -2.8], 55, { cut: true, shake: 0.4 }),
        cam(26.5, [2.6, 1.7, -0.6], [4.0, 1.1, -2.9], 55),
      ],
    },
    {
      type: 'voice',
      clips: [
        { t: 0.8, line: 'milch_kitchen_1', actor: 'Milch' },
        { t: 5.2, line: 'milch_kitchen_2', actor: 'Milch' },
        { t: 10.9, line: 'milch_knife_1', actor: 'Milch' },
        { t: 16.2, line: 'milch_photo_2', actor: 'Milch' },
      ],
    },
    {
      type: 'sound',
      clips: [
        { t: 0.2, sfx: 'breath_in', volume: 0.7 },
        { t: 3.2, sfx: 'drawer', volume: 0.9, at: 'Counter_Drawers' },
        { t: 10.1, sfx: 'knife_pickup', volume: 0.9 },
        { t: 22, sfx: 'thunder', volume: 1 },
        { t: 22.3, sfx: 'gasp', volume: 0.9 },
      ],
    },
    {
      type: 'light',
      items: [
        { t: 22, entity: 'Lightning', intensity: 9, duration: 0.04 },
        { t: 22.12, entity: 'Lightning', intensity: 0.5, duration: 0.08 },
        { t: 22.3, entity: 'Lightning', intensity: 7, duration: 0.04 },
        { t: 22.5, entity: 'Lightning', intensity: 0, duration: 0.6 },
      ],
    },
    {
      type: 'fx',
      items: [
        { t: 22, effect: 'flash', to: 0.8, duration: 0.5 },
        { t: 22, effect: 'shake', to: 0.5, duration: 1.2 },
      ],
    },
    {
      type: 'event',
      items: [
        { t: 3.2, enable: 'Counter_Drawers_Open', disable: 'Counter_Drawers' },
        { t: 3.3, enable: 'Knife_In_Drawer' },
        { t: 10.1, disable: 'Knife_In_Drawer', give: 'knife', setFlag: 'has_knife' },
        { t: 16, setFlag: 'saw_photo_2' },
        { t: 26.5, setFlag: 'heard_thunder' },
      ],
    },
  ],
});

// The mirror cabinet in the bathroom: three toothbrushes.
write('cabinet', {
  duration: 6,
  letterbox: true,
  returnControl: true,
  tracks: [
    { type: 'animation', actor: 'Milch', clips: [{ t: 0, clip: 'reach', fade: 0.3 }] },
    { type: 'camera', keys: [cam(0, [-2.75, 1.55, 1.0], [-3.0, 1.48, 0.2], 38)] },
    {
      type: 'event',
      items: [
        { t: 0.6, disable: 'Mirror_Cabinet', enable: 'Mirror_Cabinet_Open' },
        { t: 5.5, setFlag: 'saw_toothbrushes' },
      ],
    },
    { type: 'sound', clips: [{ t: 0.6, sfx: 'door_creak', volume: 0.5, at: 'Mirror_Cabinet' }] },
    { type: 'voice', clips: [{ t: 1.4, line: 'milch_toothbrushes', actor: 'Milch' }] },
  ],
});

// CS4 · Empty. Murphy's room is empty. He calls, screams, panics, and faints.
write('cs4_empty', {
  duration: 22,
  letterbox: true,
  returnControl: true,
  tracks: [
    {
      type: 'animation',
      actor: 'Milch',
      clips: [
        { t: 0, clip: 'look_around', fade: 0.3 },
        { t: 3.8, clip: 'scream', fade: 0.3 },
        { t: 8.2, clip: 'scared_breathing', loop: true, fade: 0.4 },
        { t: 13.5, clip: 'faint_collapse', fade: 0.3 },
        { t: 16.5, clip: 'lie_unconscious', loop: true, fade: 0.6 },
      ],
    },
    {
      type: 'camera',
      keys: [
        cam(0, [1.7, 4.65, 2.9], [4.4, 3.7, 1.5], 50),
        cam(3.5, [1.8, 4.6, 3.3], [4.5, 3.8, 3.2], 50),
        cam(8, [2.3, 4.2, 3.4], [3.3, 4.4, 2.4], 40, { cut: true }),
        cam(13.3, [2.1, 5.0, 3.5], [3.2, 3.6, 2.3], 55),
        cam(18, [2.9, 4.1, 3.0], [3.1, 3.1, 2.3], 45),
      ],
    },
    {
      type: 'voice',
      clips: [
        { t: 1.2, line: 'milch_murphy_1', actor: 'Milch' },
        { t: 4.0, line: 'milch_scream_2', actor: 'Milch' },
        { t: 8.4, line: 'milch_lost', actor: 'Milch' },
      ],
    },
    { type: 'sound', clips: [{ t: 14.6, sfx: 'thud_body', volume: 0.8 }] },
    {
      type: 'fx',
      items: [
        { t: 8.5, effect: 'heartbeat', to: 0.9, duration: 1 },
        { t: 8.5, effect: 'heartRate', to: 140, duration: 1 },
        { t: 11, effect: 'blur', to: 0.5, duration: 3 },
        { t: 11.5, effect: 'volume', to: 0.35, duration: 4 },
        { t: 12, effect: 'desaturate', to: 0.7, duration: 4 },
        { t: 12, effect: 'darken', to: 0.6, duration: 5 },
        { t: 12, effect: 'heartRate', to: 45, duration: 7 },
        { t: 16, effect: 'fade', to: 1, duration: 4 },
        { t: 17, effect: 'volume', to: 0, duration: 3 },
        { t: 20.5, effect: 'heartbeat', to: 0, duration: 1 },
      ],
    },
    { type: 'event', items: [{ t: 21.5, setFlag: 'fainted', emit: 'fainted' }] },
  ],
});

// CS5 · Morning. Birds, warm light through the east window. His back aches, he coughs; the shield with the
// triple spiral; the knife stuck in the floor right next to where his head lay. He takes it and hides it.
write('cs5_morning', {
  duration: 26,
  letterbox: true,
  returnControl: true,
  tracks: [
    {
      type: 'event',
      items: [
        { t: 0, emit: 'env:res://godot/environments/house-Environment_Morning.tres' },
        { t: 0, disable: 'Night' },
        { t: 0.05, enable: 'Sun' },
        { t: 0.1, enable: 'Birds' },
        { t: 0.15, enable: 'Knife_Stuck' },
        { t: 0.2, teleport: { entity: 'Milch', position: [3.2, 3.0, 2.45], rotation: [0, 200, 0] } },
      ],
    },
    {
      type: 'animation',
      actor: 'Milch',
      clips: [
        { t: 0, clip: 'lie_unconscious', loop: true, fade: 0 },
        { t: 3.6, clip: 'wake_on_floor', fade: 0.5 },
        { t: 7.2, clip: 'rub_back', fade: 0.4 },
        { t: 8.6, clip: 'cough', fade: 0.3 },
        { t: 12.4, clip: 'look_around', fade: 0.5 },
        { t: 20.4, clip: 'pick_up', fade: 0.3 },
        { t: 22.6, clip: 'hide_in_belt', fade: 0.3 },
      ],
    },
    {
      type: 'camera',
      keys: [
        cam(0, [3.55, 3.75, 3.0], [3.1, 3.12, 2.25], 40),
        cam(7, [2.2, 4.4, 3.4], [3.2, 3.8, 2.4], 50, { cut: true }),
        cam(12.2, [3.5, 4.5, 1.9], [5.05, 4.55, 1.3], 40, { cut: true }),
        cam(16.8, [3.45, 3.75, 2.75], [3.05, 3.12, 2.15], 38, { cut: true }),
        cam(20.2, [2.0, 4.5, 3.5], [3.2, 3.8, 2.4], 50, { cut: true }),
      ],
    },
    {
      type: 'voice',
      clips: [
        { t: 4.4, line: 'milch_morning_1', actor: 'Milch' },
        { t: 10.0, line: 'milch_morning_2', actor: 'Milch' },
        { t: 15.2, line: 'milch_knife_2', actor: 'Milch' },
        { t: 18.6, line: 'milch_knife_3', actor: 'Milch' },
      ],
    },
    {
      type: 'sound',
      clips: [
        { t: 8.7, sfx: 'cough', volume: 0.8 },
        { t: 21, sfx: 'knife_pickup', volume: 0.9 },
      ],
    },
    {
      type: 'fx',
      items: [
        { t: 0, effect: 'fade', to: 1, duration: 0 },
        { t: 0, effect: 'heartbeat', to: 0, duration: 0 },
        { t: 0, effect: 'darken', to: 0, duration: 0 },
        { t: 0, effect: 'desaturate', to: 0, duration: 0 },
        { t: 1.5, effect: 'fade', to: 0, duration: 4 },
        { t: 1, effect: 'volume', to: 1, duration: 4 },
        { t: 1.5, effect: 'blur', to: 0, duration: 5 },
      ],
    },
    {
      type: 'event',
      items: [
        { t: 21, disable: 'Knife_Stuck', setFlag: 'knife_found' },
        { t: 25.5, setFlag: 'leave_cabin' },
      ],
    },
  ],
});

// Leaving the cabin: end of Chapter 1.
write('cs6_leave', {
  duration: 9,
  letterbox: true,
  returnControl: false,
  tracks: [
    {
      type: 'fx',
      items: [
        { t: 0, effect: 'fade', to: 1, duration: 3 },
        { t: 0.5, effect: 'volume', to: 0, duration: 3 },
      ],
    },
    {
      type: 'subtitle',
      items: [
        { t: 3.5, duration: 4.5, text: 'The Sidle of Milch' },
        { t: 4.2, duration: 3.8, text: 'End of Chapter 1: The House' },
      ],
    },
    { type: 'event', items: [{ t: 8.5, setFlag: 'chapter1_complete', emit: 'chapter_end' }] },
  ],
});
