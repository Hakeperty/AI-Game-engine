/**
 * Errors are part of the AI interface: every failure carries a stable `code`, a human/AI readable
 * `message`, and (whenever possible) a `hint` that says how to fix it.
 */
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNKNOWN_COMMAND'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'BUILD_FAILED'
  | 'SCRIPT_ERROR'
  | 'RENDER_FAILED'
  | 'TIMEOUT'
  | 'IO_ERROR'
  | 'UNSUPPORTED'
  | 'INTERNAL';

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  hint?: string;
  details?: unknown;
}

export class AigeError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { hint?: string; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AigeError';
    this.code = code;
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.details !== undefined) this.details = opts.details;
  }

  toJSON(): ErrorInfo {
    const out: ErrorInfo = { code: this.code, message: this.message };
    if (this.hint) out.hint = this.hint;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof AigeError) return err.toJSON();
  if (err instanceof Error) return { code: 'INTERNAL', message: err.message };
  return { code: 'INTERNAL', message: String(err) };
}

/** Levenshtein distance, used for "did you mean" suggestions. */
export function editDistance(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Returns up to `max` candidates closest to `input` (substring matches first, then edit distance). */
export function suggest(input: string, candidates: Iterable<string>, max = 3): string[] {
  const lower = input.toLowerCase();
  const scored: { c: string; score: number }[] = [];
  for (const c of candidates) {
    const cl = c.toLowerCase();
    let score = editDistance(lower, cl);
    if (cl.includes(lower) || lower.includes(cl)) score = Math.min(score, 1);
    const limit = Math.max(2, Math.floor(Math.max(input.length, c.length) / 2));
    if (score <= limit) scored.push({ c, score });
  }
  scored.sort((x, y) => x.score - y.score || x.c.localeCompare(y.c));
  return [...new Set(scored.map((s) => s.c))].slice(0, max);
}

export function didYouMean(input: string, candidates: Iterable<string>): string | undefined {
  const s = suggest(input, candidates);
  if (s.length === 0) return undefined;
  return `Did you mean ${s.map((x) => `'${x}'`).join(' or ')}?`;
}
