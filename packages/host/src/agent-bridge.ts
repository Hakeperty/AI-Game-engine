import type { CommandSource, ToolDefinition } from '@aige/core';
import type { Workspace } from './host.ts';

/**
 * Structural implementation of @aige/agent's ToolHost on top of a Workspace, so the in-editor
 * agent (and `aige agent`) can drive the engine with the same tools as MCP clients.
 */
export interface WorkspaceToolHost {
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, input: unknown): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string; hint?: string } }>;
  transaction<T>(label: string, fn: () => Promise<T>): Promise<T>;
  context(): Promise<string>;
}

export function workspaceToolHost(ws: Workspace, source: CommandSource = 'agent'): WorkspaceToolHost {
  return {
    listTools: () => ws.tools(),
    callTool: (name, input) => ws.call(name, input, source),
    async transaction(label, fn) {
      const host = ws.current;
      return host ? host.bus.transaction(label, source, fn) : fn();
    },
    async context() {
      const host = ws.current;
      if (!host) return 'No project is open. Use project_create or project_open first.';
      const tree = await host.call<{ scene: string; entityCount: number; tree: string }>('scene_tree', { depth: 6 }, 'internal');
      if (!tree.ok) return `Project ${host.state.project.name}`;
      const lines = tree.result.tree.split('\n');
      const shown = lines.slice(0, 60).join('\n');
      const more = lines.length > 60 ? `\n... ${lines.length - 60} more lines (use scene_tree / entity_find)` : '';
      return `Project: ${host.state.project.name} (${host.root})\nScene ${tree.result.scene} (${tree.result.entityCount} entities):\n${shown}${more}`;
    },
  };
}
