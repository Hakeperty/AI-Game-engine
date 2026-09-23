/**
 * Writer for Godot 4 text resources: scenes (.tscn, format 3) and resources (.tres).
 *
 * Values are written with the Variant text syntax. Use the helpers (`vec3`, `color`, `ext`, `sub`, ...)
 * for typed values; plain numbers, booleans, strings, arrays and objects are converted automatically.
 */

/** A value already in Godot's text syntax. */
export class Raw {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export type GdValue = Raw | string | number | boolean | null | GdValue[] | { [key: string]: GdValue };

/** Formats a float the way Godot does: shortest round-trip, 6 significant decimals at most. */
export function num(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  const r = Math.round(n * 1e6) / 1e6;
  if (r === 0) return '0';
  return String(r);
}

/** Quotes a string for Godot text resources. */
export function str(s: string): string {
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

export function format(v: GdValue): string {
  if (v instanceof Raw) return v.text;
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return num(v);
  if (typeof v === 'string') return str(v);
  if (Array.isArray(v)) return `[${v.map(format).join(', ')}]`;
  const entries = Object.entries(v).map(([k, x]) => `${str(k)}: ${format(x)}`);
  return entries.length ? `{\n${entries.join(',\n')}\n}` : '{}';
}

export const vec2 = (x: number, y: number) => new Raw(`Vector2(${num(x)}, ${num(y)})`);
export const vec3 = (v: readonly number[]) => new Raw(`Vector3(${num(v[0]!)}, ${num(v[1]!)}, ${num(v[2]!)})`);

/** '#rrggbb' (sRGB, as Godot stores colors in resources) → Color(r, g, b, a). */
export function color(hex: string, alpha = 1): Raw {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
  return new Raw(`Color(${c.map(num).join(', ')}, ${num(alpha)})`);
}

export const strings = (list: readonly string[]) => new Raw(`PackedStringArray(${list.map(str).join(', ')})`);
export const nodePath = (p: string) => new Raw(`NodePath(${str(p)})`);
export const ext = (id: string) => new Raw(`ExtResource(${str(id)})`);
export const sub = (id: string) => new Raw(`SubResource(${str(id)})`);

/** Transform3D from a column-major 4x4 matrix (three.js `Matrix4.elements`). Godot lists the basis by rows. */
export function transform3d(m: ArrayLike<number>): Raw {
  const rows = [m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!, m[12]!, m[13]!, m[14]!];
  return new Raw(`Transform3D(${rows.map(num).join(', ')})`);
}

export const IDENTITY_TRANSFORM = 'Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)';

interface Resource {
  kind: 'ext' | 'sub';
  type: string;
  id: string;
  path?: string;
  props?: Record<string, GdValue>;
}

export interface NodeSpec {
  name: string;
  /** Omit for instanced scenes. */
  type?: string;
  /** Path of the parent relative to the root: '.' for root children, 'A/B' deeper. Omit for the root. */
  parent?: string;
  /** ExtResource id of a PackedScene to instance. */
  instance?: string;
  groups?: string[];
  props?: Record<string, GdValue | undefined>;
}

/** Collects resources and nodes, then writes a .tscn (or .tres) file. */
export class TscnWriter {
  private readonly resources: Resource[] = [];
  private readonly extByPath = new Map<string, string>();
  private readonly subByKey = new Map<string, string>();
  private readonly nodes: NodeSpec[] = [];
  private counter = 0;

  /** Adds (or reuses) an external resource and returns its id. */
  ext(type: string, path: string): string {
    const key = `${type}|${path}`;
    let id = this.extByPath.get(key);
    if (!id) {
      id = `${++this.counter}_${type.toLowerCase().slice(0, 12)}`;
      this.extByPath.set(key, id);
      this.resources.push({ kind: 'ext', type, id, path });
    }
    return id;
  }

  /** Adds a sub-resource and returns its id. Identical resources (same type and props) are shared. */
  sub(type: string, props: Record<string, GdValue | undefined>): string {
    const clean = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)) as Record<
      string,
      GdValue
    >;
    const key = `${type}|${JSON.stringify(clean, (_k, v) => (v instanceof Raw ? `\u0000${v.text}` : v))}`;
    let id = this.subByKey.get(key);
    if (!id) {
      id = `${type}_${++this.counter}`;
      this.subByKey.set(key, id);
      this.resources.push({ kind: 'sub', type, id, props: clean });
    }
    return id;
  }

  node(spec: NodeSpec): void {
    this.nodes.push(spec);
  }

  get nodeCount(): number {
    return this.nodes.length;
  }

  private writeResources(): string[] {
    const out: string[] = [];
    for (const r of this.resources.filter((x) => x.kind === 'ext'))
      out.push(`[ext_resource type=${str(r.type)} path=${str(r.path!)} id=${str(r.id)}]`);
    if (out.length) out.push('');
    for (const r of this.resources.filter((x) => x.kind === 'sub')) {
      out.push(`[sub_resource type=${str(r.type)} id=${str(r.id)}]`);
      for (const [k, v] of Object.entries(r.props ?? {})) out.push(`${k} = ${format(v)}`);
      out.push('');
    }
    return out;
  }

  /** A scene file. The first node added is the root. */
  scene(): string {
    const steps = this.resources.length + 1;
    const out = [`[gd_scene load_steps=${steps} format=3]`, '', ...this.writeResources()];
    for (const n of this.nodes) {
      const attrs = [`name=${str(n.name)}`];
      if (n.type) attrs.push(`type=${str(n.type)}`);
      if (n.parent !== undefined) attrs.push(`parent=${str(n.parent)}`);
      if (n.instance) attrs.push(`instance=ExtResource(${str(n.instance)})`);
      if (n.groups?.length) attrs.push(`groups=[${n.groups.map(str).join(', ')}]`);
      out.push(`[node ${attrs.join(' ')}]`);
      for (const [k, v] of Object.entries(n.props ?? {}))
        if (v !== undefined) out.push(`${k} = ${format(v)}`);
      out.push('');
    }
    return `${out.join('\n').trimEnd()}\n`;
  }

  /** A standalone resource file (.tres) whose main resource has the given type and props. */
  resource(type: string, props: Record<string, GdValue | undefined>): string {
    const steps = this.resources.length + 1;
    const out = [
      `[gd_resource type=${str(type)} load_steps=${steps} format=3]`,
      '',
      ...this.writeResources(),
    ];
    out.push('[resource]');
    for (const [k, v] of Object.entries(props)) if (v !== undefined) out.push(`${k} = ${format(v)}`);
    return `${out.join('\n').trimEnd()}\n`;
  }
}

/** Godot node names can't contain . : @ / " % and must be unique among siblings. */
export function nodeName(name: string): string {
  const clean = name.replace(/[.:@/"%]/g, '_').trim();
  return clean || 'Node';
}

/** 'requireFlag' → 'RequireFlag' (AIGE schema field → C# property). */
export function pascal(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}
