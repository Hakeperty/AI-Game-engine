import { z } from 'zod';
import type { AnyCommand } from './commands/define.ts';

export type JsonSchema = Record<string, any>;

/**
 * JSON Schema for a command's input, simplified for LLM tool calling:
 * tuples become fixed-length number arrays, `$schema` is dropped, and the root is always an object.
 */
export function inputJsonSchema(cmd: AnyCommand): JsonSchema {
  const schema = z.toJSONSchema(cmd.input, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  delete schema.$schema;
  const out = simplify(schema);
  if (out.type !== 'object') return { type: 'object', properties: {}, additionalProperties: true };
  return out;
}

function simplify(node: any): any {
  if (Array.isArray(node)) return node.map(simplify);
  if (!node || typeof node !== 'object') return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) out[k] = simplify(v);
  if (Array.isArray(out.prefixItems)) {
    const items = out.prefixItems as any[];
    const allNumbers = items.every((i) => i.type === 'number');
    delete out.prefixItems;
    out.items = allNumbers ? { type: 'number' } : (items[0] ?? {});
    out.minItems = items.length;
    out.maxItems = items.length;
  }
  return out;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
  kind: AnyCommand['kind'];
  tier: AnyCommand['tier'];
  group: string;
}

export function toolDefinitions(cmds: AnyCommand[]): ToolDefinition[] {
  return cmds
    .map((c) => ({
      name: c.name,
      description: c.description,
      input_schema: inputJsonSchema(c),
      kind: c.kind,
      tier: c.tier,
      group: c.group,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Compact TypeScript-like signature of a zod object, e.g.
 * `{ kind?: 'dynamic'|'fixed'|'kinematic' = 'dynamic', mass?: number = 1 }`.
 * Used in docs and tool descriptions because it is far cheaper in tokens than JSON Schema.
 */
export function signature(schema: z.ZodType): string {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  return renderType(js, 0);
}

function renderType(node: JsonSchema, depth: number): string {
  if (!node || typeof node !== 'object') return 'any';
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map((v: unknown) => JSON.stringify(v).replaceAll('"', "'")).join('|');
  if (node.anyOf || node.oneOf) {
    const opts = (node.anyOf ?? node.oneOf) as JsonSchema[];
    return opts.map((o) => renderType(o, depth)).join(' | ');
  }
  switch (node.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      if (node.prefixItems) {
        const items = node.prefixItems as JsonSchema[];
        if (items.every((i) => i.type === 'number')) {
          return items.length === 3 ? '[x,y,z]' : items.length === 2 ? '[x,y]' : `number[${items.length}]`;
        }
        return `[${items.map((i) => renderType(i, depth)).join(', ')}]`;
      }
      const inner = renderType(node.items ?? {}, depth);
      return inner.includes(' ') && !inner.startsWith('{') ? `(${inner})[]` : `${inner}[]`;
    }
    case 'object': {
      const props = node.properties as Record<string, JsonSchema> | undefined;
      if (!props || Object.keys(props).length === 0) {
        return node.additionalProperties && typeof node.additionalProperties === 'object'
          ? `Record<string, ${renderType(node.additionalProperties, depth)}>`
          : '{}';
      }
      if (depth > 2) return '{...}';
      const req = new Set<string>(node.required ?? []);
      const parts = Object.entries(props).map(([k, v]) => {
        const opt = req.has(k) ? '' : '?';
        const def = v.default !== undefined ? ` = ${JSON.stringify(v.default).replaceAll('"', "'")}` : '';
        return `${k}${opt}: ${renderType(v, depth + 1)}${def}`;
      });
      return `{ ${parts.join(', ')} }`;
    }
    default:
      return 'any';
  }
}
