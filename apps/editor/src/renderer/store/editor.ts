import type { Entity, ProjectState, SceneDoc } from '@aige/core';
import { create } from 'zustand';
import type { EditorInfo } from '../../shared/protocol.ts';

export type TransformTool = 'translate' | 'rotate' | 'scale';
export type PlayState = 'edit' | 'playing' | 'paused';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ConsoleEntry {
  id: number;
  time: number;
  level: LogLevel;
  /** 'ui' | 'mcp' | 'agent' | 'runtime' | 'editor' | ... */
  source: string;
  message: string;
  hint?: string;
  detail?: string;
  count: number;
}

export interface HistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
}

export interface EditorStore {
  connected: boolean;
  info: EditorInfo | null;
  /** Project root; null when no project is open. */
  root: string | null;
  /** Read-only replica of the host's ProjectState (updated from immer patches). */
  state: ProjectState | null;
  version: number;
  history: HistoryInfo;
  selection: string | null;
  tool: TransformTool;
  space: 'local' | 'world';
  snap: boolean;
  play: PlayState;
  /** Project files (from the host). */
  files: string[];
  /** Per-path change counter, bumped on every `files` bus event (cache busting). */
  fileVersions: Record<string, number>;
  logs: ConsoleEntry[];
  /** Timestamp of the last command that came from an MCP client (live indicator). */
  mcpActivityAt: number;
  agentActivityAt: number;
}

export const useEditor = create<EditorStore>(() => ({
  connected: false,
  info: null,
  root: null,
  state: null,
  version: 0,
  history: { canUndo: false, canRedo: false },
  selection: null,
  tool: 'translate',
  space: 'world',
  snap: false,
  play: 'edit',
  files: [],
  fileVersions: {},
  logs: [],
  mcpActivityAt: 0,
  agentActivityAt: 0,
}));

export const editor = {
  get: () => useEditor.getState(),
  set: (patch: Partial<EditorStore>) => useEditor.setState(patch),
};

// ------------------------------------------------------------------ selectors

export function activeScene(s: Pick<EditorStore, 'state'>): SceneDoc | null {
  const st = s.state;
  if (!st) return null;
  return st.scenes[st.activeScene] ?? null;
}

export function selectedEntity(s: Pick<EditorStore, 'state' | 'selection'>): Entity | null {
  const scene = activeScene(s);
  if (!scene || !s.selection) return null;
  return scene.entities.find((e) => e.id === s.selection) ?? null;
}

export function select(id: string | null): void {
  if (useEditor.getState().selection !== id) useEditor.setState({ selection: id });
}

// ------------------------------------------------------------------ console

let logId = 1;
const MAX_LOGS = 1500;

export function log(
  level: LogLevel,
  message: string,
  source = 'editor',
  extra: { hint?: string; detail?: string } = {},
): void {
  const logs = useEditor.getState().logs;
  const last = logs.at(-1);
  if (
    last &&
    last.message === message &&
    last.level === level &&
    last.source === source &&
    last.hint === extra.hint
  ) {
    const next = logs.slice();
    next[next.length - 1] = { ...last, count: last.count + 1, time: Date.now() };
    useEditor.setState({ logs: next });
    return;
  }
  const entry: ConsoleEntry = { id: logId++, time: Date.now(), level, source, message, count: 1, ...extra };
  const next =
    logs.length >= MAX_LOGS ? [...logs.slice(logs.length - MAX_LOGS + 1), entry] : [...logs, entry];
  useEditor.setState({ logs: next });
}

export function clearLogs(): void {
  useEditor.setState({ logs: [] });
}
