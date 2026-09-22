/**
 * The agent loop: user request -> model turn -> tool calls -> tool results -> ... until the model
 * stops calling tools, a budget runs out, or the user cancels.
 *
 * History is append-only (earlier turns are never rewritten), the system prompt and tool list are
 * frozen per session, and volatile editor context rides in user messages. That keeps Claude's prompt
 * cache warm and its thinking blocks valid.
 */
import { didYouMean } from '@aige/core';
import {
  buildProgressSummary,
  CONTEXT_TAG,
  estimateTokens,
  lastRequestIndex,
  PLAN_TAG,
  requestText,
  windowTranscript,
} from './context.ts';
import { formatPlan, PLAN_TOOL, PLAN_TOOL_NAME, type PlanItem, parsePlanInput, planSummary } from './plan.ts';
import { estimateCostUsd } from './pricing.ts';
import { SMALL_MODEL_SYSTEM_PROMPT, SYSTEM_PROMPT } from './prompts.ts';
import {
  errorText,
  imageBlock,
  resultText,
  splitImages,
  summarizeResult,
  textBlock,
  truncate,
} from './results.ts';
import { compactDescription, simplifySchema } from './schema.ts';
import {
  type AgentTool,
  addUsage,
  type ChatEvent,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type ContentBlock,
  emptyUsage,
  type ProviderError,
  type StopReason,
  type ToolCallError,
  type ToolCallResult,
  type ToolHost,
  type ToolImage,
  type ToolResultBlock,
  type ToolSpec,
  type ToolUseBlock,
  type Usage,
} from './types.ts';

export type AgentMode = 'auto' | 'ask-destructive' | 'read-only';

export interface ApprovalRequest {
  id: string;
  name: string;
  input: unknown;
  tool: AgentTool;
  /** Why approval is needed, for the confirmation dialog. */
  reason: string;
}

export interface SmallModelOptions {
  /** Transcript budget before "stateless steps" kick in (estimated as chars/4). Default 48k. */
  contextBudgetTokens?: number;
  /** Recent assistant turns kept verbatim when condensing. Default 6. */
  keepTurns?: number;
  /** Schema property descriptions longer than this are dropped. Default 80. */
  maxDescriptionChars?: number;
  /** Tool descriptions are cut to about this many characters (plus their Example line). Default 300. */
  maxToolDescriptionChars?: number;
  /** Consecutive malformed tool-call turns fed back to the model before giving up. Default 1. */
  malformedRetries?: number;
}

export interface AgentOptions {
  provider: ChatProvider;
  tools: ToolHost;
  /** Frozen for the session. Defaults to SYSTEM_PROMPT (or SMALL_MODEL_SYSTEM_PROMPT in small-model mode). */
  systemPrompt?: string;
  /** Default 'auto'. */
  mode?: AgentMode;
  /** Asked before destructive tools in 'ask-destructive' mode. Without it those calls are denied. */
  approve?: (req: ApprovalRequest) => Promise<boolean>;
  /** Overrides which calls need approval in 'ask-destructive' mode. */
  needsApproval?: (tool: AgentTool, input: unknown) => boolean;
  /** Model requests per run(). Default 40. */
  maxTurns?: number;
  /** Most recent images kept in the outgoing context (OpenAI-compatible providers). Default 6. */
  maxImages?: number;
  /** Per-run budget of uncached input + cache-write + output tokens. Default unlimited. */
  maxTokens?: number;
  /** Per-run budget in estimated USD. Default unlimited. */
  maxCostUsd?: number;
  /** 'core' exposes only core-tier tools. Default 'all' ('core' in small-model mode). */
  tier?: 'core' | 'all';
  /** Small-model mode. Default: on for openai-compat providers. */
  smallModel?: boolean | SmallModelOptions;
  /** Tool result JSON longer than this is truncated. Default 50k chars (12k in small-model mode). */
  maxToolResultChars?: number;
  /** Suggest game_run_headless after script changes. Default true. */
  verificationHints?: boolean;
  onEvent?: (event: AgentEvent) => void;
}

export interface RunOptions {
  signal?: AbortSignal;
}

export type DoneReason =
  | 'end_turn'
  | 'max_turns'
  | 'token_budget'
  | 'cost_budget'
  | 'max_tokens'
  | 'refusal'
  | 'context_window'
  | 'aborted'
  | 'error';

export type AgentEvent =
  | { type: 'run_start'; message: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  /** The complete assistant turn as appended to the history (reconcile streamed text with it). */
  | { type: 'assistant'; content: ContentBlock[]; stopReason: StopReason }
  | { type: 'tool_start'; id: string; name: string; input: unknown; kind: AgentTool['kind'] | 'unknown' }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      ok: boolean;
      durationMs: number;
      summary: string;
      error?: ToolCallError;
      imageCount: number;
    }
  | { type: 'tool_denied'; id: string; name: string; reason: string }
  | { type: 'image'; toolUseId: string; toolName: string; image: ToolImage }
  | { type: 'plan'; items: PlanItem[] }
  | {
      type: 'usage';
      model: string;
      turn: Usage;
      /** Totals for the current run. */
      run: Usage;
      /** Totals for the whole session. */
      session: Usage;
      turnCostUsd: number;
      runCostUsd: number;
      sessionCostUsd: number;
    }
  | { type: 'notice'; message: string }
  | { type: 'error'; error: { code: string; message: string } }
  | { type: 'done'; reason: DoneReason; message?: string; text: string; turns: number };

export interface RunResult {
  reason: DoneReason;
  /** Human-readable explanation for non-normal stops. */
  message?: string;
  /** Last assistant text of the run. */
  text: string;
  turns: number;
  usage: Usage;
  costUsd: number;
}

/** Persisted session (see toJSON / fromJSON). */
export interface AgentSession {
  version: 1;
  messages: ChatMessage[];
  plan: PlanItem[];
  usage: Usage;
  costUsd: number;
  /** The frozen tool list, reused on restore so the prompt prefix stays identical. */
  tools?: AgentTool[];
}

interface RunState {
  turns: number;
  usage: Usage;
  cost: number;
  text: string;
  malformedStreak: number;
  streamRetries: number;
  scriptHintGiven: boolean;
}

const SCRIPT_TOOL_RE = /^script_(write|edit|patch|create|update)$/;
const DESTRUCTIVE_RE = /delete|remove|undo/i;
const HEADLESS_TOOL = 'game_run_headless';

const SMALL_DEFAULTS: Required<SmallModelOptions> = {
  contextBudgetTokens: 48_000,
  keepTurns: 6,
  maxDescriptionChars: 80,
  maxToolDescriptionChars: 300,
  malformedRetries: 1,
};

/**
 * Default approval rule for 'ask-destructive': any action, and mutations whose name mentions
 * delete/remove/undo (including such steps inside a `batch`).
 */
export function defaultNeedsApproval(tool: AgentTool, input: unknown): boolean {
  if (tool.name === PLAN_TOOL_NAME) return false;
  if (tool.kind === 'action') return true;
  if (tool.kind !== 'mutation') return false;
  if (DESTRUCTIVE_RE.test(tool.name)) return true;
  const steps = (input as { commands?: unknown } | null)?.commands;
  if (tool.name === 'batch' && Array.isArray(steps)) {
    return steps.some(
      (s) =>
        typeof (s as { tool?: unknown })?.tool === 'string' &&
        DESTRUCTIVE_RE.test((s as { tool: string }).tool),
    );
  }
  return false;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const ABORTED = Symbol('aborted');

function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export class Agent {
  readonly provider: ChatProvider;
  readonly tools: ToolHost;
  readonly systemPrompt: string;
  readonly smallModel: Required<SmallModelOptions> | null;
  private _mode: AgentMode;
  private readonly approve: AgentOptions['approve'];
  private readonly needsApprovalFn: (tool: AgentTool, input: unknown) => boolean;
  private readonly maxTurns: number;
  private readonly maxImages: number;
  private readonly maxTokens: number | undefined;
  private readonly maxCostUsd: number | undefined;
  private readonly tier: 'core' | 'all';
  private readonly maxToolResultChars: number;
  private readonly verificationHints: boolean;
  private readonly onEvent: AgentOptions['onEvent'];

  private messages: ChatMessage[] = [];
  private _plan: PlanItem[] = [];
  private _usage: Usage = emptyUsage();
  private _cost = 0;
  private sessionTools: AgentTool[] | null = null;
  private restoredTools: AgentTool[] | null = null;
  private toolSpecs: ToolSpec[] = [];
  private readonly toolByName = new Map<string, AgentTool>();
  private prepared = false;
  private running = false;
  private windowNoticeShown = false;

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.tools = opts.tools;
    const small = opts.smallModel ?? opts.provider.kind === 'openai-compat';
    this.smallModel =
      small === false ? null : { ...SMALL_DEFAULTS, ...(typeof small === 'object' ? small : {}) };
    this.systemPrompt = opts.systemPrompt ?? (this.smallModel ? SMALL_MODEL_SYSTEM_PROMPT : SYSTEM_PROMPT);
    this._mode = opts.mode ?? 'auto';
    this.approve = opts.approve;
    this.needsApprovalFn = opts.needsApproval ?? defaultNeedsApproval;
    this.maxTurns = opts.maxTurns ?? 40;
    this.maxImages = opts.maxImages ?? 6;
    this.maxTokens = opts.maxTokens;
    this.maxCostUsd = opts.maxCostUsd;
    this.tier = opts.tier ?? (this.smallModel ? 'core' : 'all');
    this.maxToolResultChars = opts.maxToolResultChars ?? (this.smallModel ? 12_000 : 50_000);
    this.verificationHints = opts.verificationHints ?? true;
    this.onEvent = opts.onEvent;
  }

  // ------------------------------------------------------------------ public state

  /** The append-only transcript. */
  get history(): readonly ChatMessage[] {
    return this.messages;
  }

  get plan(): readonly PlanItem[] {
    return this._plan;
  }

  /** Token usage for the whole session. */
  get usage(): Usage {
    return { ...this._usage };
  }

  get costUsd(): number {
    return this._cost;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get mode(): AgentMode {
    return this._mode;
  }

  /** Changes the approval mode. The tool list stays frozen; 'read-only' is enforced when calls run. */
  setMode(mode: AgentMode): void {
    this._mode = mode;
  }

  /** Tools exposed to the model this session (available after the first run). */
  get exposedTools(): readonly AgentTool[] {
    return this.sessionTools ?? [];
  }

  /** Clears the conversation, plan and usage. The next run starts a fresh session (tools re-listed). */
  reset(): void {
    if (this.running) throw new Error('Cannot reset while the agent is running.');
    this.messages = [];
    this._plan = [];
    this._usage = emptyUsage();
    this._cost = 0;
    this.sessionTools = null;
    this.restoredTools = null;
    this.toolSpecs = [];
    this.toolByName.clear();
    this.windowNoticeShown = false;
  }

  toJSON(): AgentSession {
    const s: AgentSession = {
      version: 1,
      messages: this.messages,
      plan: this._plan,
      usage: this._usage,
      costUsd: this._cost,
    };
    const tools = this.sessionTools ?? this.restoredTools;
    if (tools) s.tools = tools;
    return s;
  }

  static fromJSON(session: AgentSession, opts: AgentOptions): Agent {
    if (session?.version !== 1 || !Array.isArray(session.messages)) {
      throw new Error('Unsupported agent session format.');
    }
    const agent = new Agent(opts);
    agent.messages = [...session.messages];
    agent._plan = [...(session.plan ?? [])];
    agent._usage = { ...emptyUsage(), ...session.usage };
    agent._cost = session.costUsd ?? 0;
    agent.restoredTools = session.tools ?? null;
    return agent;
  }

  // ------------------------------------------------------------------ run

  /** Runs one user request to completion. The whole request is one undo step when the host supports it. */
  async run(message: string, opts: RunOptions = {}): Promise<RunResult> {
    if (this.running) throw new Error('Agent.run() is already in progress.');
    this.running = true;
    const signal = opts.signal;
    const rs: RunState = {
      turns: 0,
      usage: emptyUsage(),
      cost: 0,
      text: '',
      malformedStreak: 0,
      streamRetries: 0,
      scriptHintGiven: false,
    };
    this.emit({ type: 'run_start', message });
    try {
      const exec = () => this.loop(message, rs, signal);
      const label = `AI: ${message.replace(/\s+/g, ' ').trim().slice(0, 40)}`;
      return this.tools.transaction ? await this.tools.transaction(label, exec) : await exec();
    } catch (err) {
      if (signal?.aborted) return this.finish(rs, 'aborted');
      const msg = errMessage(err);
      this.emit({ type: 'error', error: { code: 'INTERNAL', message: msg } });
      return this.finish(rs, 'error', msg);
    } finally {
      this.running = false;
    }
  }

  private async loop(message: string, rs: RunState, signal: AbortSignal | undefined): Promise<RunResult> {
    await this.ensureSession(signal);
    const blocks: ContentBlock[] = [];
    const ctx = await this.readContext();
    if (ctx) blocks.push(textBlock(`<${CONTEXT_TAG}>\n${ctx}\n</${CONTEXT_TAG}>`));
    if (this._plan.length) blocks.push(textBlock(`<${PLAN_TAG}>\n${formatPlan(this._plan)}\n</${PLAN_TAG}>`));
    blocks.push(textBlock(message));
    this.messages.push({ role: 'user', content: blocks });

    for (;;) {
      if (signal?.aborted) return this.finish(rs, 'aborted');
      const stop = this.budgetStop(rs);
      if (stop) return this.finish(rs, stop.reason, stop.message);
      rs.turns++;

      const req: ChatRequest = {
        system: this.systemPrompt,
        tools: this.toolSpecs,
        messages: await this.outgoingMessages(),
        maxImages: this.maxImages,
      };
      const res = await this.streamTurn(req, signal);
      if ('error' in res) {
        if (res.error.code === 'aborted' || signal?.aborted) return this.finish(rs, 'aborted');
        if (res.error.code === 'malformed_output' && rs.streamRetries < 2) {
          // Unparseable tool input: nothing was appended, so re-issue the same turn.
          rs.streamRetries++;
          rs.turns--;
          this.emit({
            type: 'notice',
            message: `Model output could not be parsed (${res.error.message}); retrying.`,
          });
          continue;
        }
        this.emit({ type: 'error', error: { code: res.error.code, message: res.error.message } });
        return this.finish(rs, 'error', res.error.message);
      }
      rs.streamRetries = 0;
      const done = res.done;
      this.recordUsage(rs, done.usage, done.model ?? this.provider.model);
      for (const n of done.notices ?? []) this.emit({ type: 'notice', message: n });

      const content = done.content;
      const toolUses = content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      const text = content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n')
        .trim();

      if (done.stopReason === 'refusal') {
        // Partial output of a refused turn is discarded, and its tools are never run.
        const cat = done.refusal?.category;
        return this.finish(
          rs,
          'refusal',
          `The model declined this request${cat ? ` (category: ${cat})` : ''}. Try rephrasing it.`,
        );
      }
      if (done.stopReason === 'context_window_exceeded') {
        return this.finish(
          rs,
          'context_window',
          'The conversation no longer fits the model context. Reset the agent to continue.',
        );
      }
      if (text) rs.text = text;
      this.appendAssistant(content, done.stopReason);

      if (done.stopReason === 'pause_turn') continue;
      if (done.stopReason === 'max_tokens') {
        if (toolUses.length === 0) {
          return this.finish(rs, 'max_tokens', 'The response hit the output token limit and was cut off.');
        }
        // A tool input cut off at max_tokens can still parse as a (wrong) partial object: never run it.
        this.messages.push({
          role: 'user',
          content: toolUses.map((t) =>
            errorResult(
              t.id,
              'NOT_RUN: your output hit the max_tokens limit, so this tool call was cut off and was not executed. Split the work into smaller calls (shorter scripts, fewer steps per batch).',
            ),
          ),
        });
        this.emit({
          type: 'notice',
          message: 'Output limit reached mid tool call; asking the model to split the work.',
        });
        continue;
      }
      if (toolUses.length === 0) return this.finish(rs, 'end_turn');

      const results = await this.executeTools(toolUses, rs, signal);
      this.messages.push({ role: 'user', content: results });

      if (toolUses.some((t) => t.invalid)) {
        rs.malformedStreak++;
        const allowed = this.smallModel?.malformedRetries ?? 3;
        if (rs.malformedStreak > allowed) {
          const msg =
            'The model kept producing malformed tool calls. Try again, or use a more capable model.';
          this.emit({ type: 'error', error: { code: 'MALFORMED_TOOL_CALLS', message: msg } });
          return this.finish(rs, 'error', msg);
        }
      } else rs.malformedStreak = 0;
      if (signal?.aborted) return this.finish(rs, 'aborted');
    }
  }

  // ------------------------------------------------------------------ session setup

  private async ensureSession(signal: AbortSignal | undefined): Promise<void> {
    if (!this.prepared) {
      await this.provider.prepare?.(signal);
      this.prepared = true;
    }
    if (this.sessionTools) return;
    const hostTools = (await this.tools.listTools()).filter((t) => t.name !== PLAN_TOOL_NAME);
    let list: AgentTool[] | null = null;
    if (this.restoredTools) {
      const available = new Set(hostTools.map((t) => t.name));
      const restored = this.restoredTools.filter((t) => t.name !== PLAN_TOOL_NAME);
      if (restored.every((t) => available.has(t.name))) list = restored;
      else
        this.emit({
          type: 'notice',
          message: 'The engine tool set changed since this session was saved; using the current tools.',
        });
      this.restoredTools = null;
    }
    if (!list) {
      list = hostTools;
      if (this.tier === 'core') list = list.filter((t) => t.tier === 'core');
      if (this._mode === 'read-only') list = list.filter((t) => t.kind === 'query');
    }
    const tools = [...list, PLAN_TOOL].sort(byName);
    this.sessionTools = tools;
    this.toolByName.clear();
    for (const t of tools) this.toolByName.set(t.name, t);
    const s = this.smallModel;
    this.toolSpecs = tools.map((t) =>
      s
        ? {
            name: t.name,
            description: compactDescription(t.description, s.maxToolDescriptionChars),
            input_schema: simplifySchema(t.input_schema, { maxDescriptionChars: s.maxDescriptionChars }),
          }
        : { name: t.name, description: t.description, input_schema: t.input_schema },
    );
  }

  private async readContext(): Promise<string> {
    if (!this.tools.context) return '';
    try {
      return truncate((await this.tools.context()).trim(), 6000);
    } catch {
      return '';
    }
  }

  /** Small-model mode: condense the outgoing transcript when it exceeds the budget. */
  private async outgoingMessages(): Promise<ChatMessage[]> {
    const s = this.smallModel;
    if (!s) return this.messages;
    const fixedChars = this.systemPrompt.length + JSON.stringify(this.toolSpecs).length;
    const budget =
      Math.min(s.contextBudgetTokens, Math.floor(this.provider.caps.contextWindow * 0.75)) -
      Math.ceil(fixedChars / 4);
    if (estimateTokens(this.messages) <= budget) return this.messages;
    const ctx = await this.readContext();
    if (!this.windowNoticeShown) {
      this.windowNoticeShown = true;
      this.emit({
        type: 'notice',
        message: 'Long session: sending a condensed transcript to the model (stateless steps).',
      });
    }
    return windowTranscript(this.messages, {
      budgetTokens: Math.max(budget, 2000),
      keepTurns: s.keepTurns,
      header: (omitted) => this.condensedHeader(omitted, ctx),
    });
  }

  private condensedHeader(omitted: readonly ChatMessage[], ctx: string): string {
    const req = lastRequestIndex(omitted);
    const parts = ['[Older steps of this session were condensed to fit the context window.]'];
    if (req >= 0) parts.push(`## Current request\n${requestText(omitted[req]!)}`);
    if (this._plan.length) parts.push(`## Plan\n${formatPlan(this._plan)}`);
    const summary = buildProgressSummary(omitted);
    if (summary) parts.push(`## Progress so far\n${summary}`);
    if (ctx) parts.push(`<${CONTEXT_TAG}>\n${ctx}\n</${CONTEXT_TAG}>`);
    parts.push('Continue the task from where the progress leaves off.');
    return parts.join('\n\n');
  }

  // ------------------------------------------------------------------ model turn

  private async streamTurn(
    req: ChatRequest,
    signal: AbortSignal | undefined,
  ): Promise<{ done: Extract<ChatEvent, { type: 'message_done' }> } | { error: ProviderError }> {
    let done: Extract<ChatEvent, { type: 'message_done' }> | undefined;
    try {
      for await (const ev of this.provider.stream(req, signal)) {
        if (ev.type === 'text_delta') this.emit({ type: 'text', delta: ev.text });
        else if (ev.type === 'thinking_delta') this.emit({ type: 'thinking', delta: ev.text });
        else if (ev.type === 'message_done') done = ev;
        else if (ev.type === 'error') return { error: ev.error };
      }
    } catch (err) {
      return {
        error: signal?.aborted
          ? { code: 'aborted', message: 'Request aborted.', retryable: false }
          : { code: 'unknown', message: errMessage(err), retryable: false },
      };
    }
    if (!done) {
      return {
        error: signal?.aborted
          ? { code: 'aborted', message: 'Request aborted.', retryable: false }
          : { code: 'unknown', message: 'The model stream ended without a final message.', retryable: false },
      };
    }
    return { done };
  }

  private appendAssistant(content: ContentBlock[], stopReason: StopReason): void {
    // An assistant message with nothing replayable would be rejected by the API; skip it.
    if (!content.some((b) => b.type === 'text' || b.type === 'tool_use' || b.type === 'opaque')) return;
    this.messages.push({ role: 'assistant', content });
    this.emit({ type: 'assistant', content, stopReason });
  }

  private recordUsage(rs: RunState, usage: Usage, model: string): void {
    const cost = estimateCostUsd(model, usage);
    rs.usage = addUsage(rs.usage, usage);
    rs.cost += cost;
    this._usage = addUsage(this._usage, usage);
    this._cost += cost;
    this.emit({
      type: 'usage',
      model,
      turn: usage,
      run: { ...rs.usage },
      session: { ...this._usage },
      turnCostUsd: cost,
      runCostUsd: rs.cost,
      sessionCostUsd: this._cost,
    });
  }

  private budgetStop(rs: RunState): { reason: DoneReason; message: string } | undefined {
    if (rs.turns >= this.maxTurns) {
      return {
        reason: 'max_turns',
        message: `Stopped after ${this.maxTurns} model turns (maxTurns). Say "continue" to keep going.`,
      };
    }
    const used = rs.usage.inputTokens + rs.usage.cacheWriteTokens + rs.usage.outputTokens;
    if (this.maxTokens !== undefined && used >= this.maxTokens) {
      return {
        reason: 'token_budget',
        message: `Stopped: this request used ${used} tokens (budget ${this.maxTokens}). Say "continue" to keep going.`,
      };
    }
    if (this.maxCostUsd !== undefined && rs.cost >= this.maxCostUsd) {
      return {
        reason: 'cost_budget',
        message: `Stopped: this request cost about $${rs.cost.toFixed(2)} (budget $${this.maxCostUsd.toFixed(2)}).`,
      };
    }
    return undefined;
  }

  private finish(rs: RunState, reason: DoneReason, message?: string): RunResult {
    const result: RunResult = { reason, text: rs.text, turns: rs.turns, usage: rs.usage, costUsd: rs.cost };
    if (message) result.message = message;
    this.emit({ type: 'done', reason, text: rs.text, turns: rs.turns, ...(message ? { message } : {}) });
    return result;
  }

  // ------------------------------------------------------------------ tools

  /**
   * Runs a turn's tool calls: consecutive read-only queries concurrently, mutations/actions one at a
   * time in emitted order. Returns one tool_result per call, in order (sent as ONE user message).
   */
  private async executeTools(
    uses: ToolUseBlock[],
    rs: RunState,
    signal: AbortSignal | undefined,
  ): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = new Array(uses.length);
    const concurrent = (u: ToolUseBlock) => !u.invalid && this.toolByName.get(u.name)?.kind === 'query';
    let i = 0;
    while (i < uses.length) {
      if (concurrent(uses[i]!)) {
        let j = i;
        while (j < uses.length && concurrent(uses[j]!)) j++;
        const batch = await Promise.all(uses.slice(i, j).map((u) => this.runTool(u, rs, signal)));
        batch.forEach((r, k) => {
          results[i + k] = r;
        });
        i = j;
      } else {
        results[i] = await this.runTool(uses[i]!, rs, signal);
        i++;
      }
    }
    return results;
  }

  private async runTool(
    use: ToolUseBlock,
    rs: RunState,
    signal: AbortSignal | undefined,
  ): Promise<ToolResultBlock> {
    const tool = this.toolByName.get(use.name);
    if (signal?.aborted)
      return errorResult(use.id, 'CANCELLED: the user stopped the agent before this tool ran.');
    this.emit({
      type: 'tool_start',
      id: use.id,
      name: use.name,
      input: use.input,
      kind: tool?.kind ?? 'unknown',
    });
    const t0 = Date.now();
    const fail = (err: ToolCallError): ToolResultBlock => {
      this.emit({
        type: 'tool_end',
        id: use.id,
        name: use.name,
        ok: false,
        durationMs: Date.now() - t0,
        summary: `${err.code}: ${err.message}`,
        error: err,
        imageCount: 0,
      });
      return {
        type: 'tool_result',
        tool_use_id: use.id,
        content: [textBlock(errorText(err))],
        is_error: true,
      };
    };

    if (use.invalid) {
      return fail({
        code: 'INVALID_JSON',
        message: `The arguments for '${use.name}' could not be parsed (${use.invalid.error}). Nothing was run. Received: ${truncate(use.invalid.raw, 400)}`,
        hint: 'Call the tool again with a single valid JSON object that matches its input schema.',
      });
    }
    if (!tool) {
      const suggestion = didYouMean(use.name, this.toolByName.keys());
      return fail({
        code: 'UNKNOWN_TOOL',
        message: `There is no tool named '${use.name}' in this session.`,
        hint: suggestion ?? 'Use one of the tools you were given.',
      });
    }
    if (this._mode === 'read-only' && tool.kind !== 'query') {
      return fail({
        code: 'READ_ONLY',
        message: `'${use.name}' changes the project, but the agent is in read-only mode.`,
        hint: 'Describe the change to the user instead of making it.',
      });
    }
    if (this._mode === 'ask-destructive' && this.needsApprovalFn(tool, use.input)) {
      const reason =
        tool.kind === 'action'
          ? `${tool.name} is an action with side effects`
          : `${tool.name} can delete or undo work`;
      let approved = false;
      if (this.approve) {
        try {
          const r = await raceAbort(
            this.approve({ id: use.id, name: use.name, input: use.input, tool, reason }),
            signal,
          );
          approved = r === true;
        } catch {
          approved = false;
        }
      }
      if (!approved) {
        const why = signal?.aborted
          ? 'cancelled'
          : this.approve
            ? 'denied by the user'
            : 'no approver configured';
        this.emit({ type: 'tool_denied', id: use.id, name: use.name, reason: why });
        return fail({
          code: 'DENIED',
          message: `The user did not approve '${use.name}' (${why}). It was not run.`,
          hint: 'Do not retry the same call. Continue without it or ask the user how to proceed.',
        });
      }
    }

    let res: ToolCallResult;
    if (tool.name === PLAN_TOOL_NAME) res = this.applyPlan(use.input);
    else {
      try {
        res = await this.tools.callTool(use.name, use.input, signal ? { signal } : {});
      } catch (err) {
        res = {
          ok: false,
          error: { code: signal?.aborted ? 'CANCELLED' : 'INTERNAL', message: errMessage(err) },
        };
      }
    }
    if (!res.ok)
      return fail(res.error ?? { code: 'INTERNAL', message: 'The tool failed without an error message.' });

    const { images, stripped } = splitImages(res.result);
    const content: ToolResultBlock['content'] = [
      textBlock(truncate(resultText(stripped), this.maxToolResultChars)),
    ];
    if (images.length) {
      if (this.provider.caps.vision) content.push(...images.map(imageBlock));
      else
        content.push(
          textBlock(`(${images.length} image(s) not shown: the current model cannot see images.)`),
        );
      for (const image of images) this.emit({ type: 'image', toolUseId: use.id, toolName: use.name, image });
    }
    const hint = this.verificationHint(tool, rs);
    if (hint) content.push(textBlock(hint));
    this.emit({
      type: 'tool_end',
      id: use.id,
      name: use.name,
      ok: true,
      durationMs: Date.now() - t0,
      summary: summarizeResult(stripped, images.length),
      imageCount: images.length,
    });
    return { type: 'tool_result', tool_use_id: use.id, content };
  }

  private applyPlan(input: unknown): ToolCallResult {
    const p = parsePlanInput(input);
    if (!p.ok) {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: `Invalid plan: ${p.error}`,
          hint: 'Send the full list: {"items":[{"text":"...","status":"pending"}]}',
        },
      };
    }
    this._plan = p.items;
    this.emit({ type: 'plan', items: p.items.map((i) => ({ ...i })) });
    return { ok: true, result: planSummary(p.items) };
  }

  /** A light nudge to play-test after gameplay scripts change (once per run until the game is run). */
  private verificationHint(tool: AgentTool, rs: RunState): string | undefined {
    if (!this.verificationHints) return undefined;
    if (tool.name === HEADLESS_TOOL) {
      rs.scriptHintGiven = false;
      return undefined;
    }
    if (
      tool.kind === 'mutation' &&
      SCRIPT_TOOL_RE.test(tool.name) &&
      !rs.scriptHintGiven &&
      this.toolByName.has(HEADLESS_TOOL)
    ) {
      rs.scriptHintGiven = true;
      return `Note: gameplay code changed. Before finishing, verify it with ${HEADLESS_TOOL} using scripted inputs and check for script errors.`;
    }
    return undefined;
  }

  private emit(e: AgentEvent): void {
    try {
      this.onEvent?.(e);
    } catch {
      // UI listeners must never break the loop
    }
  }
}

function errorResult(id: string, text: string): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: id, content: [textBlock(text)], is_error: true };
}
