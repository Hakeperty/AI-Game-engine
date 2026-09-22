import { AigeError } from '@aige/core';
import type { World } from './world.ts';

// The scripting singletons (Input, Time, Game, ...) act on "the world that is currently running".
// World sets this around every frame and every call into user code.
let current: World | null = null;

export function currentWorld(): World | null {
  return current;
}

export function requireWorld(what: string): World {
  if (current) return current;
  throw new AigeError('INVALID_STATE', `${what} can only be used while a game is running.`, {
    hint: 'Use it inside Behaviour hooks such as awake(), start(), update(dt) or onTriggerEnter(other), not at module top level.',
  });
}

/** Makes `world` current and returns the previous one (restore it with exitWorld). */
export function enterWorld(world: World): World | null {
  const prev = current;
  current = world;
  return prev;
}

export function exitWorld(prev: World | null): void {
  current = prev;
}
