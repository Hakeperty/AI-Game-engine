/** The built-in `plan_update` tool: a TodoWrite-style checklist shared by the model and the UI. */
import { z } from 'zod';
import type { AgentTool } from './types.ts';

export type PlanStatus = 'pending' | 'in_progress' | 'done';

export interface PlanItem {
  text: string;
  status: PlanStatus;
}

export const PLAN_TOOL_NAME = 'plan_update';

const PlanInput = z
  .object({
    items: z
      .array(
        z
          .object({
            text: z.string().min(1).max(300),
            status: z.enum(['pending', 'in_progress', 'done']),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();

export const PLAN_TOOL: AgentTool = {
  name: PLAN_TOOL_NAME,
  description: `Create or replace your task checklist. The user sees it live. Call it at the start of any multi-step request, then again whenever an item starts (in_progress) or is verified (done). Always send the complete list. Keep at most one item in_progress.
Example: {"items":[{"text":"Build coin and player models","status":"done"},{"text":"Place level platforms","status":"in_progress"},{"text":"Verify with game_run_headless","status":"pending"}]}`,
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        maxItems: 30,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Short imperative step' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
          },
          required: ['text', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
  kind: 'query',
  tier: 'core',
  group: 'agent',
};

export function parsePlanInput(
  input: unknown,
): { ok: true; items: PlanItem[] } | { ok: false; error: string } {
  const res = PlanInput.safeParse(input);
  if (res.success) return { ok: true, items: res.data.items };
  const issues = res.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
  return { ok: false, error: issues };
}

const MARK: Record<PlanStatus, string> = { done: '[x]', in_progress: '[~]', pending: '[ ]' };

export function formatPlan(items: PlanItem[]): string {
  return items.map((i) => `${MARK[i.status]} ${i.text}`).join('\n');
}

export function planSummary(items: PlanItem[]): string {
  const done = items.filter((i) => i.status === 'done').length;
  const active = items.find((i) => i.status === 'in_progress');
  return `Plan updated: ${done}/${items.length} done${active ? `; in progress: ${active.text}` : ''}.`;
}
