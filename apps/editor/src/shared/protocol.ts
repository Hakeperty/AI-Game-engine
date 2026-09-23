/**
 * Messages between the editor renderer and the host utility process (over a MessagePort), and between
 * the Electron main process and the host (over the utility process parentPort).
 *
 * The base messages mirror `ClientMessage` / `ServerMessage` from @aige/host's protocol.ts (the same
 * protocol MCP clients use over WebSocket). The editor adds `editor.*` and `agent.*` messages, which the
 * editor host handles itself (see src/host/endpoint.ts).
 */
import type { AgentEvent, PlanItem } from '@aige/agent';
import type { BusEvent, CommandSource, ErrorInfo, ProjectState } from '@aige/core';

// ------------------------------------------------------------------ base host protocol (mirrors @aige/host)

export type BaseClientMessage =
  | { id: number; type: 'call'; name: string; input?: unknown; source?: CommandSource }
  | { id: number; type: 'tools' }
  | { id: number; type: 'state' }
  | { id: number; type: 'model'; path: string; params?: Record<string, unknown> }
  | { id: number; type: 'subscribe' }
  | {
      id: number;
      type: 'transaction';
      label: string;
      calls: { name: string; input?: unknown }[];
      source?: CommandSource;
    };

export interface StateSnapshot {
  root: string | null;
  state: ProjectState | null;
  version: number;
}

/** Subset of @aige/host ModelInfo the editor uses. */
export interface ModelInfoLite {
  path: string;
  key: string;
  params: Record<string, unknown>;
  paramDefs: Record<string, ParamDefLite>;
  bounds: { min: number[]; max: number[]; size: number[]; center: number[] };
  triangles: number;
  parts: string[];
  collider: { shape: string; size?: number[]; radius?: number; height?: number; offset?: number[] } | null;
  issues: string[];
  logs: string[];
  buildMs: number;
}

export type ParamDefLite =
  | { type: 'number'; default: number; min?: number; max?: number; step?: number; description?: string }
  | { type: 'int'; default: number; min?: number; max?: number; description?: string }
  | { type: 'color'; default: string; description?: string }
  | { type: 'boolean'; default: boolean; description?: string }
  | { type: 'choice'; default: string; options: string[]; description?: string };

export interface ModelAsset {
  key: string;
  info: ModelInfoLite;
  /** base64 GLB */
  glb: string;
}

// ------------------------------------------------------------------ editor extensions

export interface RecentProject {
  path: string;
  name: string;
  openedAt: string;
}

export interface EditorInfo {
  workspaceDir: string;
  recent: RecentProject[];
  root: string | null;
  apiPort: number | null;
  mcpClients: number;
}

/** Provider settings sent with every agent run (never contains secrets). */
export type AgentProviderConfig =
  | { kind: 'anthropic'; model: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  | { kind: 'openai-compat'; baseURL: string; model: string };

export type AgentMode = 'auto' | 'ask-destructive' | 'read-only';

export interface AgentRunRequest {
  text: string;
  provider: AgentProviderConfig;
  mode: AgentMode;
  /** Currently selected entity (id), added to the agent's context. */
  selection?: string | null;
}

export interface AgentApprovalRequest {
  id: string;
  name: string;
  input: unknown;
  reason: string;
}

/** Agent UI state kept by the host so a reloaded renderer can restore the chat. */
export interface AgentSnapshot {
  running: boolean;
  events: AgentUiEvent[];
  approvals: AgentApprovalRequest[];
  plan: PlanItem[];
}

/** AgentEvent plus the editor's own user-message event. */
export type AgentUiEvent = AgentEvent | { type: 'user'; text: string } | { type: 'reset' };

export interface CompiledScript {
  path: string;
  code: string;
}

export type EditorClientMessage =
  | { id: number; type: 'editor.info' }
  | { id: number; type: 'editor.files' }
  | { id: number; type: 'editor.readText'; path: string }
  | { id: number; type: 'editor.readBinary'; path: string }
  | { id: number; type: 'editor.scripts' }
  | { id: number; type: 'editor.thumbnail'; path: string; params?: Record<string, unknown> }
  | { id: number; type: 'editor.forgetRecent'; path: string }
  | { id: number; type: 'editor.ollamaModels'; baseURL: string }
  | { id: number; type: 'agent.run'; request: AgentRunRequest }
  | { id: number; type: 'agent.stop' }
  | { id: number; type: 'agent.reset' }
  | { id: number; type: 'agent.state' }
  | { id: number; type: 'agent.approve'; requestId: string; approved: boolean };

export type ClientMessage = BaseClientMessage | EditorClientMessage;

export type ServerMessage =
  | { type: 'reply'; id: number; ok: true; result: unknown }
  | { type: 'reply'; id: number; ok: false; error: ErrorInfo }
  | { type: 'event'; event: BusEvent }
  | { type: 'project'; root: string | null; state: ProjectState | null; version: number }
  | { type: 'editor.status'; info: EditorInfo }
  | { type: 'agent.event'; event: AgentUiEvent }
  | { type: 'agent.approval'; request: AgentApprovalRequest }
  | { type: 'agent.approvalDone'; id: string };

// ------------------------------------------------------------------ main <-> host (parentPort)

export type MainToHost =
  | { type: 'port' }
  | { type: 'secrets'; anthropicApiKey: string | null; openaiApiKey: string | null }
  | { type: 'shutdown' };

export type HostToMain =
  | { type: 'ready'; apiPort: number | null }
  | { type: 'project'; root: string | null; name: string | null }
  | { type: 'fatal'; message: string };

// ------------------------------------------------------------------ preload bridge (window.aige)

export interface ApiKeyStatus {
  anthropic: boolean;
  /** An ANTHROPIC_API_KEY environment variable is set for the editor process. */
  anthropicEnv: boolean;
  encryptionAvailable: boolean;
}

export interface AigeBridge {
  /** Asks main for a fresh MessagePort to the host; it arrives as a window 'message' event 'aige:host-port'. */
  connectHost(): void;
  openFolderDialog(title?: string): Promise<string | null>;
  setApiKey(provider: 'anthropic', key: string): Promise<ApiKeyStatus>;
  clearApiKey(provider: 'anthropic'): Promise<ApiKeyStatus>;
  apiKeyStatus(): Promise<ApiKeyStatus>;
  revealInFolder(path: string): void;
  toggleDevTools(): void;
  readonly platform: string;
  readonly isDev: boolean;
}

export const HOST_PORT_MESSAGE = 'aige:host-port';
