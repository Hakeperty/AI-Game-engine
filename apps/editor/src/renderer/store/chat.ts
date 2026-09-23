import type { PlanItem, ToolImage } from '@aige/agent';
import { create } from 'zustand';
import type { AgentApprovalRequest, AgentSnapshot, AgentUiEvent } from '../../shared/protocol.ts';

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; thinking: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      status: 'running' | 'ok' | 'error' | 'denied';
      summary?: string;
      error?: { code: string; message: string; hint?: string };
      durationMs?: number;
      images: ToolImage[];
    }
  | { kind: 'notice'; id: string; text: string; level: 'info' | 'error' }
  | { kind: 'done'; id: string; reason: string; message?: string };

export interface ChatUsage {
  sessionTokens: number;
  sessionCostUsd: number;
  runCostUsd: number;
  model: string | null;
  lastInput: number;
  lastOutput: number;
}

export interface ChatStore {
  items: ChatItem[];
  running: boolean;
  plan: PlanItem[];
  usage: ChatUsage;
  approvals: AgentApprovalRequest[];
}

const emptyUsage = (): ChatUsage => ({
  sessionTokens: 0,
  sessionCostUsd: 0,
  runCostUsd: 0,
  model: null,
  lastInput: 0,
  lastOutput: 0,
});

export const useChat = create<ChatStore>(() => ({
  items: [],
  running: false,
  plan: [],
  usage: emptyUsage(),
  approvals: [],
}));

let seq = 0;
const nid = () => `c${++seq}`;

function reduce(s: ChatStore, e: AgentUiEvent): ChatStore {
  const items = s.items;
  const last = items.at(-1);
  const replaceLast = (item: ChatItem) => [...items.slice(0, -1), item];
  const finalize = (): ChatItem[] =>
    last?.kind === 'assistant' && last.streaming ? replaceLast({ ...last, streaming: false }) : items;
  switch (e.type) {
    case 'reset':
      return { items: [], running: false, plan: [], usage: emptyUsage(), approvals: [] };
    case 'user':
      return { ...s, items: [...finalize(), { kind: 'user', id: nid(), text: e.text }] };
    case 'run_start':
      return { ...s, running: true, usage: { ...s.usage, runCostUsd: 0 } };
    case 'text':
      if (last?.kind === 'assistant' && last.streaming)
        return { ...s, items: replaceLast({ ...last, text: last.text + e.delta }) };
      return {
        ...s,
        items: [...items, { kind: 'assistant', id: nid(), text: e.delta, thinking: '', streaming: true }],
      };
    case 'thinking':
      if (last?.kind === 'assistant' && last.streaming)
        return { ...s, items: replaceLast({ ...last, thinking: last.thinking + e.delta }) };
      return {
        ...s,
        items: [...items, { kind: 'assistant', id: nid(), text: '', thinking: e.delta, streaming: true }],
      };
    case 'assistant': {
      const text = e.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n')
        .trim();
      if (last?.kind === 'assistant' && last.streaming) {
        return {
          ...s,
          items: replaceLast({ ...last, text: last.text.trim() ? last.text : text, streaming: false }),
        };
      }
      if (text)
        return {
          ...s,
          items: [...items, { kind: 'assistant', id: nid(), text, thinking: '', streaming: false }],
        };
      return s;
    }
    case 'tool_start':
      return {
        ...s,
        items: [
          ...finalize(),
          { kind: 'tool', id: e.id, name: e.name, input: e.input, status: 'running', images: [] },
        ],
      };
    case 'tool_end':
    case 'tool_denied':
    case 'image': {
      const id = e.type === 'image' ? e.toolUseId : e.id;
      const idx = items.findLastIndex((i) => i.kind === 'tool' && i.id === id);
      if (idx < 0) return s;
      const item = items[idx] as Extract<ChatItem, { kind: 'tool' }>;
      let next: ChatItem;
      if (e.type === 'tool_end') {
        next = {
          ...item,
          status: e.ok ? 'ok' : 'error',
          summary: e.summary,
          durationMs: e.durationMs,
          ...(e.error ? { error: e.error } : {}),
        };
      } else if (e.type === 'tool_denied') next = { ...item, status: 'denied', summary: e.reason };
      else next = { ...item, images: [...item.images, e.image] };
      const copy = items.slice();
      copy[idx] = next;
      return { ...s, items: copy };
    }
    case 'plan':
      return { ...s, plan: e.items };
    case 'usage':
      return {
        ...s,
        usage: {
          sessionTokens:
            e.session.inputTokens +
            e.session.outputTokens +
            e.session.cacheReadTokens +
            e.session.cacheWriteTokens,
          sessionCostUsd: e.sessionCostUsd,
          runCostUsd: e.runCostUsd,
          model: e.model,
          lastInput: e.turn.inputTokens + e.turn.cacheReadTokens + e.turn.cacheWriteTokens,
          lastOutput: e.turn.outputTokens,
        },
      };
    case 'notice':
      return { ...s, items: [...finalize(), { kind: 'notice', id: nid(), text: e.message, level: 'info' }] };
    case 'error':
      return {
        ...s,
        items: [...finalize(), { kind: 'notice', id: nid(), text: e.error.message, level: 'error' }],
      };
    case 'done':
      return {
        ...s,
        running: false,
        items: [
          ...finalize(),
          ...(e.reason !== 'end_turn'
            ? [
                {
                  kind: 'done' as const,
                  id: nid(),
                  reason: e.reason,
                  ...(e.message ? { message: e.message } : {}),
                },
              ]
            : []),
        ],
      };
    default:
      return s;
  }
}

export function applyAgentEvent(e: AgentUiEvent): void {
  useChat.setState((s) => reduce(s, e));
}

export function restoreChat(snap: AgentSnapshot): void {
  let s: ChatStore = { items: [], running: false, plan: [], usage: emptyUsage(), approvals: [] };
  for (const e of snap.events) s = reduce(s, e);
  useChat.setState({
    ...s,
    running: snap.running,
    approvals: snap.approvals,
    plan: snap.plan.length ? snap.plan : s.plan,
  });
}

export function addApproval(req: AgentApprovalRequest): void {
  useChat.setState((s) => ({ approvals: [...s.approvals.filter((a) => a.id !== req.id), req] }));
}

export function removeApproval(id: string): void {
  useChat.setState((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }));
}

export function pushLocalNotice(text: string, level: 'info' | 'error' = 'error'): void {
  useChat.setState((s) => ({ items: [...s.items, { kind: 'notice', id: nid(), text, level }] }));
}
