import type { BusEvent, ProjectState, ToolResult } from '@aige/core';
import { applyPatches, enablePatches } from 'immer';
import type { AgentSnapshot, EditorInfo, ServerMessage, StateSnapshot } from '../../shared/protocol.ts';
import { addApproval, applyAgentEvent, removeApproval, restoreChat } from '../store/chat.ts';
import { activeScene, editor, log } from '../store/editor.ts';
import { host } from './client.ts';

enablePatches();

/**
 * Keeps the renderer's replica of ProjectState in sync with the host:
 * snapshot on subscribe, immer patches from bus events, full replace on project/reset.
 */
export function startSession(): void {
  host.onConnect(() => void onConnected());
  host.onMessageEvent(onMessage);
  host.connect();
}

async function onConnected(): Promise<void> {
  try {
    const snap = await host.request<StateSnapshot>({ type: 'subscribe' });
    applySnapshot(snap);
    editor.set({ connected: true });
    void refreshInfo();
    void refreshHistory();
    const chat = await host.request<AgentSnapshot>({ type: 'agent.state' });
    restoreChat(chat);
  } catch (err) {
    log('error', `Could not subscribe to the host: ${(err as Error).message}`);
  }
}

function applySnapshot(snap: StateSnapshot): void {
  const prev = editor.get();
  const sameProject = prev.root === snap.root;
  editor.set({
    root: snap.root,
    state: snap.state,
    version: snap.version,
    ...(sameProject ? {} : { selection: null, history: { canUndo: false, canRedo: false } }),
  });
  pruneSelection();
  scheduleFiles();
}

async function resync(): Promise<void> {
  try {
    applySnapshot(await host.request<StateSnapshot>({ type: 'state' }));
  } catch {
    // retried on the next event
  }
}

export async function refreshInfo(): Promise<EditorInfo | null> {
  try {
    const info = await host.request<EditorInfo>({ type: 'editor.info' });
    editor.set({ info });
    return info;
  } catch {
    return null;
  }
}

async function refreshHistory(): Promise<void> {
  if (!editor.get().state) return;
  const r = await host.call<{ undo: string[]; redo: string[] }>('history', { limit: 1 });
  if (r.ok) {
    editor.set({
      history: {
        canUndo: r.result.undo.length > 0,
        canRedo: r.result.redo.length > 0,
        ...(r.result.undo[0] ? { undoLabel: r.result.undo[0] } : {}),
        ...(r.result.redo[0] ? { redoLabel: r.result.redo[0] } : {}),
      },
    });
  }
}

let filesTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleFiles(): void {
  if (filesTimer) clearTimeout(filesTimer);
  filesTimer = setTimeout(async () => {
    filesTimer = null;
    if (!editor.get().root) {
      editor.set({ files: [] });
      return;
    }
    try {
      editor.set({ files: await host.request<string[]>({ type: 'editor.files' }) });
    } catch {
      // ignore
    }
  }, 120);
}

function pruneSelection(): void {
  const s = editor.get();
  if (!s.selection) return;
  const scene = activeScene(s);
  if (!scene?.entities.some((e) => e.id === s.selection)) editor.set({ selection: null });
}

function onMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'event':
      onBusEvent(msg.event);
      return;
    case 'project':
      applySnapshot({ root: msg.root, state: msg.state, version: msg.version });
      void refreshInfo();
      void refreshHistory();
      if (msg.root) log('info', `Opened project ${msg.state?.project.name ?? msg.root}`);
      return;
    case 'editor.status':
      editor.set({ info: msg.info });
      return;
    case 'agent.event':
      applyAgentEvent(msg.event);
      if (msg.event.type === 'tool_start') editor.set({ agentActivityAt: Date.now() });
      if (msg.event.type === 'error') log('error', msg.event.error.message, 'agent');
      return;
    case 'agent.approval':
      addApproval(msg.request);
      return;
    case 'agent.approvalDone':
      removeApproval(msg.id);
      return;
    case 'reply':
      return;
  }
}

function onBusEvent(e: BusEvent): void {
  const s = editor.get();
  switch (e.type) {
    case 'state': {
      if (!s.state || e.version !== s.version + 1) {
        void resync();
        return;
      }
      editor.set({ state: applyPatches(s.state, e.patches) as ProjectState, version: e.version });
      pruneSelection();
      return;
    }
    case 'reset':
      editor.set({ state: e.state, version: e.version });
      pruneSelection();
      scheduleFiles();
      return;
    case 'files': {
      const fileVersions = { ...s.fileVersions };
      for (const p of e.paths) fileVersions[p] = (fileVersions[p] ?? 0) + 1;
      editor.set({ fileVersions });
      scheduleFiles();
      return;
    }
    case 'history':
      editor.set({
        history: {
          canUndo: e.canUndo,
          canRedo: e.canRedo,
          ...(e.undoLabel ? { undoLabel: e.undoLabel } : {}),
          ...(e.redoLabel ? { redoLabel: e.redoLabel } : {}),
        },
      });
      return;
    case 'log':
      log(e.level, e.message, e.source);
      return;
    case 'command': {
      if (e.source === 'mcp') editor.set({ mcpActivityAt: Date.now() });
      if (e.source === 'agent') editor.set({ agentActivityAt: Date.now() });
      // UI-originated failures are reported by run(); report everything else here.
      if (e.source === 'ui') return;
      if (!e.ok && e.error)
        log('error', `${e.name}: ${e.error.message}`, e.source, e.error.hint ? { hint: e.error.hint } : {});
      else if (e.source === 'mcp' || e.source === 'agent') log('info', `${e.name} (${e.ms} ms)`, e.source);
      return;
    }
  }
}

/**
 * Calls a tool from the UI (source 'ui'). Errors are written to the console with their hint.
 * Returns the result, or null on failure.
 */
export async function run<T = any>(
  tool: string,
  input: unknown = {},
  opts: { quiet?: boolean } = {},
): Promise<T | null> {
  const r: ToolResult<T> = await host.call<T>(tool, input);
  if (r.ok) return r.result;
  if (!opts.quiet)
    log('error', `${tool}: ${r.error.message}`, 'ui', r.error.hint ? { hint: r.error.hint } : {});
  return null;
}

/** Like run(), but returns the full ToolResult (for callers that show errors inline). */
export function call<T = any>(tool: string, input: unknown = {}): Promise<ToolResult<T>> {
  return host.call<T>(tool, input);
}

export function undo(): void {
  void run('undo', { steps: 1 });
}

export function redo(): void {
  void run('redo', { steps: 1 });
}
