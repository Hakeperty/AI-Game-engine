import type { z } from 'zod';
import type { ProjectState } from '../state.ts';

export type CommandKind = 'mutation' | 'query' | 'action';
export type CommandTier = 'core' | 'extended';
export type CommandSource = 'ui' | 'mcp' | 'agent' | 'cli' | 'replay' | 'test' | 'internal';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Image returned by a command (screenshots, previews). Adapters turn these into image content parts. */
export interface ImageRef {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** base64 data (no data: prefix). */
  data: string;
  label?: string;
  /** Project-relative path where the image was also saved, if any. */
  path?: string;
  width?: number;
  height?: number;
}

export interface CommandContext<S = unknown> {
  /** Current project state (read-only; frozen). */
  readonly state: ProjectState;
  /** Mutates the state through an immer draft. Records patches for undo/redo and replicas. */
  update(recipe: (draft: ProjectState) => void): void;
  readFile(path: string): Promise<string | null>;
  /** Writes a project file; the previous content is snapshotted so the write can be undone. */
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  /** Runs another command inside the current transaction (atomic: rolled back if it throws). */
  call<O = any>(name: string, input?: unknown): Promise<O>;
  log(level: LogLevel, message: string): void;
  readonly services: S;
  readonly source: CommandSource;
  readonly signal?: AbortSignal;
}

export interface CommandDef<I extends z.ZodType = z.ZodType, O = unknown, S = any> {
  /** Tool name; must match ^[a-zA-Z0-9_-]{1,64}$. */
  name: string;
  group: string;
  /** mutation: changes project state/files (undoable, logged); query: read-only; action: side effects (render, run, export). */
  kind: CommandKind;
  /** core commands are exposed to small local models; extended only to capable models. */
  tier: CommandTier;
  /** Written for an AI reader: what it does, when to use it, and one example input. */
  description: string;
  input: I;
  /** Undo/redo manage history themselves and must not create history entries. */
  skipHistory?: boolean;
  run(ctx: CommandContext<S>, input: z.output<I>): Promise<O> | O;
}

export const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function defineCommand<I extends z.ZodType, O, S = any>(
  def: CommandDef<I, O, S>,
): CommandDef<I, O, S> {
  if (!TOOL_NAME_RE.test(def.name)) throw new Error(`Invalid command name '${def.name}'`);
  return def;
}

export type AnyCommand = CommandDef<z.ZodType, unknown, any>;
