/**
 * Canonical JSON: stable key order, rounded numbers, compact numeric tuples.
 * Every file AIGE writes goes through this so diffs stay small and replay is byte-identical.
 */

const PRIORITY_KEYS = [
  'format',
  'version',
  'id',
  'type',
  'name',
  'parent',
  'active',
  'tags',
  'transform',
  'position',
  'rotation',
  'scale',
];
const PRIORITY = new Map(PRIORITY_KEYS.map((k, i) => [k, i]));

export function roundNumber(n: number, precision = 1e5): number {
  if (!Number.isFinite(n)) return 0;
  const r = Math.round(n * precision) / precision;
  return Object.is(r, -0) ? 0 : r;
}

function compareKeys(a: string, b: string): number {
  const pa = PRIORITY.get(a);
  const pb = PRIORITY.get(b);
  if (pa !== undefined && pb !== undefined) return pa - pb;
  if (pa !== undefined) return -1;
  if (pb !== undefined) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function isInlineArray(v: unknown[]): boolean {
  return v.length <= 4 && v.every((x) => typeof x === 'number' || typeof x === 'boolean');
}

function write(value: unknown, indent: string, step: string): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return JSON.stringify(roundNumber(value));
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (isInlineArray(value)) return `[${value.map((v) => write(v, '', '')).join(', ')}]`;
    const inner = indent + step;
    return `[\n${value.map((v) => inner + write(v, inner, step)).join(',\n')}\n${indent}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    entries.sort(([a], [b]) => compareKeys(a, b));
    const inner = indent + step;
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${write(v, inner, step)}`).join(',\n')}\n${indent}}`;
  }
  return 'null';
}

/** Pretty, canonical JSON with a trailing newline. */
export function canonicalJson(value: unknown): string {
  return write(value, '', '  ') + '\n';
}

/** Compact single-line canonical JSON (for logs and tool output). */
export function compactJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** Deep-copies `value` with rounded numbers and canonical key order. */
export function normalize<T>(value: T): T {
  if (typeof value === 'number') return roundNumber(value) as T;
  if (Array.isArray(value)) return value.map((v) => normalize(v)) as T;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => compareKeys(a, b));
    return Object.fromEntries(entries.map(([k, v]) => [k, normalize(v)])) as T;
  }
  return value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a as object).filter((k) => (a as any)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as any)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}
