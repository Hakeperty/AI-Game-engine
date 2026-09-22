import { applyPatches, enablePatches, type Patch, produceWithPatches } from 'immer';
import type { z } from 'zod';
import { AigeError, didYouMean, type ErrorInfo, toErrorInfo } from '../errors.ts';
import type { ProjectState } from '../state.ts';
import type { AnyCommand, CommandContext, CommandSource, LogLevel } from './define.ts';

enablePatches();

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

/** File access the bus needs; the host implements it on disk, tests in memory. */
export interface BusFs {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  files: FileChange[];
  source: CommandSource;
  commands: number;
}

export interface LogEntry {
  seq: number;
  name: string;
  input: unknown;
  source: CommandSource;
}

export type BusEvent =
  | { type: 'state'; patches: Patch[]; reason: 'command' | 'undo' | 'redo'; version: number }
  | { type: 'reset'; state: ProjectState; version: number }
  | { type: 'files'; paths: string[] }
  | { type: 'command'; name: string; source: CommandSource; ok: boolean; ms: number; error?: ErrorInfo }
  | { type: 'log'; level: LogLevel; message: string; source: CommandSource }
  | { type: 'history'; canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string };

export interface ExecuteOptions {
  source?: CommandSource;
  signal?: AbortSignal;
}

interface Txn {
  /** One entry per ctx.update() call, so we can roll back to any savepoint. */
  batches: { patches: Patch[]; inverse: Patch[] }[];
  files: FileChange[];
  mutated: boolean;
}

const txnPatches = (t: Txn): Patch[] => t.batches.flatMap((b) => b.patches);
const txnInverse = (t: Txn): Patch[] => t.batches.toReversed().flatMap((b) => b.inverse);

export type ToolResult<O = unknown> = { ok: true; result: O } | { ok: false; error: ErrorInfo };

const MAX_HISTORY = 300;

export class CommandBus<S = any> {
  private _state: ProjectState;
  private _version = 0;
  private readonly commands = new Map<string, AnyCommand>();
  private readonly listeners = new Set<(e: BusEvent) => void>();
  private readonly logListeners = new Set<(e: LogEntry) => void>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private openGroup: HistoryEntry | null = null;
  private readonly fs: BusFs;
  services: S;

  constructor(state: ProjectState, fs: BusFs, services: S) {
    this._state = state;
    this.fs = fs;
    this.services = services;
  }

  get state(): ProjectState {
    return this._state;
  }

  get version(): number {
    return this._version;
  }

  // ------------------------------------------------------------------ registry

  register(...cmds: AnyCommand[]): this {
    for (const c of cmds) {
      if (this.commands.has(c.name)) throw new Error(`Command '${c.name}' already registered`);
      this.commands.set(c.name, c);
    }
    return this;
  }

  get(name: string): AnyCommand {
    const cmd = this.commands.get(name);
    if (!cmd) {
      throw new AigeError('UNKNOWN_COMMAND', `Unknown tool '${name}'.`, {
        hint: didYouMean(name, this.commands.keys()) ?? 'List tools to see what is available.',
      });
    }
    return cmd;
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  list(): AnyCommand[] {
    return [...this.commands.values()];
  }

  // ------------------------------------------------------------------ events

  on(listener: (e: BusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onLog(listener: (e: LogEntry) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  emit(e: BusEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // listeners must never break command execution
      }
    }
  }

  log(level: LogLevel, message: string, source: CommandSource = 'internal'): void {
    this.emit({ type: 'log', level, message, source });
  }

  /** Replaces the whole state (project open). Clears history. */
  reset(state: ProjectState): void {
    this._state = state;
    this.undoStack = [];
    this.redoStack = [];
    this._version++;
    this.emit({ type: 'reset', state, version: this._version });
    this.emitHistory();
  }

  // ------------------------------------------------------------------ execution

  /** Executes a command and returns its result; throws AigeError on failure. */
  execute<O = any>(name: string, input: unknown = {}, opts: ExecuteOptions = {}): Promise<O> {
    const run = this.queue.then(() => this.executeNow<O>(name, input, opts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Like execute, but never throws: returns { ok, result } or { ok: false, error }. */
  async call<O = any>(name: string, input: unknown = {}, opts: ExecuteOptions = {}): Promise<ToolResult<O>> {
    try {
      return { ok: true, result: await this.execute<O>(name, input, opts) };
    } catch (err) {
      return { ok: false, error: toErrorInfo(err) };
    }
  }

  /**
   * Groups every mutation executed inside `fn` into a single undo step (e.g. one AI turn).
   * Commands are still logged individually so replay stays exact.
   */
  async transaction<T>(label: string, source: CommandSource, fn: () => Promise<T>): Promise<T> {
    if (this.openGroup) return fn();
    this.openGroup = { label, patches: [], inverse: [], files: [], source, commands: 0 };
    try {
      return await fn();
    } finally {
      const g = this.openGroup;
      this.openGroup = null;
      if (g && (g.patches.length || g.files.length)) {
        this.pushHistory(g);
      }
    }
  }

  private async executeNow<O>(name: string, rawInput: unknown, opts: ExecuteOptions): Promise<O> {
    const source = opts.source ?? 'internal';
    const started = Date.now();
    const txn: Txn = { batches: [], files: [], mutated: false };
    let cmd: AnyCommand | undefined;
    try {
      cmd = this.get(name);
      const result = await this.runInTxn<O>(cmd, rawInput, txn, source, opts.signal);
      if (cmd.kind === 'mutation') {
        this.logListeners.forEach((l) => {
          l({ seq: ++this.seq, name, input: rawInput ?? {}, source });
        });
      }
      this.commit(cmd, txn, source);
      this.emit({ type: 'command', name, source, ok: true, ms: Date.now() - started });
      return result;
    } catch (err) {
      await this.rollback(txn, 0, 0);
      const info = toErrorInfo(err);
      this.emit({ type: 'command', name, source, ok: false, ms: Date.now() - started, error: info });
      throw err instanceof AigeError ? err : new AigeError(info.code, info.message, { cause: err });
    }
  }

  private parseInput(cmd: AnyCommand, rawInput: unknown): unknown {
    const res = (cmd.input as z.ZodType).safeParse(rawInput ?? {});
    if (res.success) return res.data;
    const issues = res.error.issues
      .map((i) => {
        const path = i.path.length ? i.path.join('.') : '(input)';
        const keys = i.code === 'unrecognized_keys' ? ` ${JSON.stringify((i as any).keys)}` : '';
        return `${path}: ${i.message}${keys}`;
      })
      .join('; ');
    throw new AigeError('INVALID_INPUT', `Invalid input for ${cmd.name}: ${issues}`, {
      hint: firstExampleLine(cmd.description),
    });
  }

  private async runInTxn<O>(
    cmd: AnyCommand,
    rawInput: unknown,
    txn: Txn,
    source: CommandSource,
    signal: AbortSignal | undefined,
  ): Promise<O> {
    const input = this.parseInput(cmd, rawInput);
    const bus = this;
    const ctx: CommandContext<S> = {
      get state() {
        return bus._state;
      },
      update(recipe) {
        if (cmd.kind === 'query') {
          throw new AigeError('INTERNAL', `Query command '${cmd.name}' attempted to modify state.`);
        }
        const [next, patches, inverse] = produceWithPatches(bus._state, recipe);
        if (patches.length === 0) return;
        bus._state = next;
        txn.batches.push({ patches, inverse });
        txn.mutated = true;
      },
      readFile: (path) => this.fs.read(path),
      writeFile: async (path, content) => {
        await this.recordFile(txn, path, content);
      },
      deleteFile: async (path) => {
        await this.recordFile(txn, path, null);
      },
      call: async <T>(name: string, input?: unknown): Promise<T> => {
        const nested = this.get(name);
        const p = txn.batches.length;
        const f = txn.files.length;
        try {
          return await this.runInTxn<T>(nested, input, txn, source, signal);
        } catch (err) {
          await this.rollback(txn, p, f);
          throw err;
        }
      },
      log: (level, message) => this.emit({ type: 'log', level, message, source }),
      services: this.services,
      source,
      ...(signal ? { signal } : {}),
    };
    return (await cmd.run(ctx, input)) as O;
  }

  private async recordFile(txn: Txn, path: string, content: string | null): Promise<void> {
    let change = txn.files.find((f) => f.path === path);
    if (!change) {
      change = { path, before: await this.fs.read(path), after: null };
      txn.files.push(change);
    }
    if (content === null) await this.fs.remove(path);
    else await this.fs.write(path, content);
    change.after = content;
    txn.mutated = true;
  }

  /** Rolls the transaction back to the given batch/file savepoint. */
  private async rollback(txn: Txn, batchMark: number, fileMark: number): Promise<void> {
    while (txn.batches.length > batchMark) {
      const b = txn.batches.pop()!;
      this._state = applyPatches(this._state, b.inverse);
    }
    for (let i = txn.files.length - 1; i >= fileMark; i--) {
      const f = txn.files[i]!;
      if (f.before === null) await this.fs.remove(f.path);
      else await this.fs.write(f.path, f.before);
    }
    txn.files.length = fileMark;
  }

  private commit(cmd: AnyCommand, txn: Txn, source: CommandSource): void {
    if (!txn.mutated) return;
    const patches = txnPatches(txn);
    if (patches.length) {
      this._version++;
      this.emit({ type: 'state', patches, reason: 'command', version: this._version });
    }
    const changedFiles = txn.files.filter((f) => f.before !== f.after);
    if (changedFiles.length) this.emit({ type: 'files', paths: changedFiles.map((f) => f.path) });
    if (cmd.skipHistory || (patches.length === 0 && changedFiles.length === 0)) return;
    const entry: HistoryEntry = {
      label: cmd.name,
      patches,
      inverse: txnInverse(txn),
      files: changedFiles,
      source,
      commands: 1,
    };
    if (this.openGroup) {
      const g = this.openGroup;
      g.patches.push(...entry.patches);
      g.inverse = [...entry.inverse, ...g.inverse];
      for (const f of entry.files) {
        const existing = g.files.find((x) => x.path === f.path);
        if (existing) existing.after = f.after;
        else g.files.push({ ...f });
      }
      g.commands++;
      return;
    }
    this.pushHistory(entry);
  }

  private pushHistory(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.emitHistory();
  }

  private emitHistory(): void {
    const u = this.undoStack.at(-1);
    const r = this.redoStack.at(-1);
    this.emit({
      type: 'history',
      canUndo: !!u,
      canRedo: !!r,
      ...(u ? { undoLabel: u.label } : {}),
      ...(r ? { redoLabel: r.label } : {}),
    });
  }

  // ------------------------------------------------------------------ undo / redo (called by commands)

  historyInfo(): { undo: string[]; redo: string[] } {
    return {
      undo: this.undoStack
        .map((e) => (e.commands > 1 ? `${e.label} (${e.commands} commands)` : e.label))
        .reverse(),
      redo: this.redoStack.map((e) => e.label).reverse(),
    };
  }

  /** Applies the newest undo entry. Must be called from inside a command (serialized). */
  async undoInternal(): Promise<string | null> {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this._state = applyPatches(this._state, entry.inverse);
    for (const f of entry.files) {
      if (f.before === null) await this.fs.remove(f.path);
      else await this.fs.write(f.path, f.before);
    }
    this.redoStack.push(entry);
    this._version++;
    if (entry.inverse.length)
      this.emit({ type: 'state', patches: entry.inverse, reason: 'undo', version: this._version });
    if (entry.files.length) this.emit({ type: 'files', paths: entry.files.map((f) => f.path) });
    this.emitHistory();
    return entry.label;
  }

  async redoInternal(): Promise<string | null> {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this._state = applyPatches(this._state, entry.patches);
    for (const f of entry.files) {
      if (f.after === null) await this.fs.remove(f.path);
      else await this.fs.write(f.path, f.after);
    }
    this.undoStack.push(entry);
    this._version++;
    if (entry.patches.length)
      this.emit({ type: 'state', patches: entry.patches, reason: 'redo', version: this._version });
    if (entry.files.length) this.emit({ type: 'files', paths: entry.files.map((f) => f.path) });
    this.emitHistory();
    return entry.label;
  }

  /** Re-executes a command log (e.g. .aige/logs/commands.jsonl) against the current state. */
  async replay(entries: Iterable<Pick<LogEntry, 'name' | 'input'>>): Promise<number> {
    let n = 0;
    for (const e of entries) {
      await this.execute(e.name, e.input, { source: 'replay' });
      n++;
    }
    return n;
  }
}

function firstExampleLine(description: string): string | undefined {
  const m = description.match(/Example:?\s*(\{.*\})/s);
  return m ? `Example input: ${m[1]!.split('\n')[0]}` : undefined;
}
