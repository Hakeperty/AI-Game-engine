/**
 * Tool-schema compaction for small local models: fewer tokens, fewer constructs they trip over.
 */

export type JsonSchema = Record<string, any>;

export interface SimplifyOptions {
  /** Property descriptions longer than this are dropped. Default 80. */
  maxDescriptionChars?: number;
}

const NOISE_KEYS = ['default', 'examples', 'title', '$schema', '$id', 'deprecated', 'readOnly', 'writeOnly'];
/** Keywords whose value is a single subschema. */
const SUBSCHEMA_KEYS = ['items', 'additionalProperties', 'not', 'contains', 'propertyNames'];
/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LIST_KEYS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
/** Keywords whose value is a map of name -> subschema. */
const SUBSCHEMA_MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions'];

const isNullSchema = (s: unknown): boolean =>
  !!s && typeof s === 'object' && (s as JsonSchema).type === 'null' && Object.keys(s as object).length === 1;

/**
 * Returns a simplified copy of a JSON Schema:
 * - drops `default`, `examples`, `title` and other noise;
 * - drops descriptions longer than `maxDescriptionChars`;
 * - flattens `anyOf`/`oneOf` with a `null` branch (`T | null` -> `T`) and `type: [T, 'null']` -> `T`.
 */
export function simplifySchema(schema: JsonSchema, opts: SimplifyOptions = {}): JsonSchema {
  const max = opts.maxDescriptionChars ?? 80;
  return simplifyNode(schema, max) as JsonSchema;
}

function simplifyNode(node: unknown, max: number): unknown {
  if (Array.isArray(node)) return node.map((n) => simplifyNode(n, max));
  if (!node || typeof node !== 'object') return node;
  let src = node as JsonSchema;

  // T | null  ->  T
  for (const key of ['anyOf', 'oneOf'] as const) {
    const opts = src[key];
    if (Array.isArray(opts) && opts.some(isNullSchema)) {
      const rest = opts.filter((o) => !isNullSchema(o));
      const { [key]: _drop, ...others } = src;
      if (rest.length === 1 && rest[0] && typeof rest[0] === 'object') {
        // Outer keys (description) win over the branch's own.
        src = { ...(rest[0] as JsonSchema), ...others };
      } else {
        src = { ...others, [key]: rest };
      }
    }
  }
  if (Array.isArray(src.type)) {
    const types = (src.type as string[]).filter((t) => t !== 'null');
    src = { ...src, type: types.length === 1 ? types[0] : types };
  }

  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(src)) {
    if (NOISE_KEYS.includes(k)) continue;
    if (k === 'description') {
      if (typeof v === 'string' && v.length <= max) out[k] = v;
      continue;
    }
    if (SUBSCHEMA_KEYS.includes(k)) out[k] = typeof v === 'object' ? simplifyNode(v, max) : v;
    else if (SUBSCHEMA_LIST_KEYS.includes(k))
      out[k] = Array.isArray(v) ? v.map((s) => simplifyNode(s, max)) : v;
    else if (SUBSCHEMA_MAP_KEYS.includes(k) && v && typeof v === 'object') {
      const m: JsonSchema = {};
      for (const [name, sub] of Object.entries(v as JsonSchema)) m[name] = simplifyNode(sub, max);
      out[k] = m;
    } else out[k] = v;
  }
  return out;
}

/**
 * Shortens a tool description for small models: the first paragraph (cut at a sentence boundary
 * near `maxChars`) plus the `Example:` line, which small models rely on most.
 */
export function compactDescription(description: string, maxChars = 300): string {
  const exampleIdx = description.search(/Example:?\s*\{/);
  const example = exampleIdx >= 0 ? description.slice(exampleIdx).split('\n')[0]!.trim() : '';
  const body = (exampleIdx >= 0 ? description.slice(0, exampleIdx) : description).trim();
  let first = body
    .split(/\n\s*\n/)[0]!
    .replace(/\s+/g, ' ')
    .trim();
  if (first.length > maxChars) {
    const cut = first.slice(0, maxChars);
    const dot = cut.lastIndexOf('. ');
    first = dot > maxChars * 0.4 ? cut.slice(0, dot + 1) : `${cut.trimEnd()}…`;
  }
  return example ? `${first}\n${example}` : first;
}
