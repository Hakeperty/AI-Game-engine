import { type BusFs, CommandBus } from './commands/bus.ts';
import { historyCommands } from './commands/history.ts';
import { projectCommands } from './commands/project.ts';
import { sceneCommands } from './commands/scene.ts';
import type { ProjectState } from './state.ts';

export * from './animation/index.ts';
export * from './commands/bus.ts';
export * from './commands/define.ts';
export * from './commands/history.ts';
export * from './commands/project.ts';
export * from './commands/scene.ts';
export * from './errors.ts';
export * from './json.ts';
export * from './schema/common.ts';
export * from './schema/components.ts';
export * from './schema/documents.ts';
export * from './schema/environment.ts';
export * from './state.ts';
export * from './tools.ts';
export * from './transform.ts';

export const coreCommands = [...sceneCommands, ...projectCommands, ...historyCommands];

/** In-memory BusFs, for tests and headless experiments. */
export class MemoryFs implements BusFs {
  readonly files = new Map<string, string>();
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, content: string) {
    this.files.set(path, content);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
}

/** Creates a bus with all core commands registered and `services.bus` wired up. */
export function createCoreBus<S extends object>(
  state: ProjectState,
  fs: BusFs,
  services: S = {} as S,
): CommandBus<S & { bus: CommandBus<any> }> {
  const svc = services as S & { bus: CommandBus<any> };
  const bus = new CommandBus(state, fs, svc);
  svc.bus = bus;
  bus.register(...coreCommands);
  return bus;
}
