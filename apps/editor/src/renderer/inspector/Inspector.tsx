import {
  type ComponentData,
  type Entity,
  getComponentDef,
  listComponentDefs,
  SceneSettings,
} from '@aige/core';
import { useEffect, useMemo, useState } from 'react';
import type { ParamDefLite } from '../../shared/protocol.ts';
import { host } from '../host/client.ts';
import { run } from '../host/session.ts';
import type { PanelProps } from '../layout/Dock.tsx';
import { openModel, openScript } from '../layout/workspace.ts';
import { scriptProps } from '../play/scripts.ts';
import { activeScene, selectedEntity, useEditor } from '../store/editor.ts';
import { resolveModel } from '../three/assets.ts';
import {
  ColorField,
  NumberField,
  SelectField,
  SliderField,
  TextField,
  Toggle,
  Vec2Field,
  Vec3Field,
} from '../ui/fields.tsx';
import { Icon } from '../ui/Icon.tsx';
import { type MenuItem, openMenu, openMenuAt } from '../ui/overlays.tsx';
import { sceneViewport } from '../viewport/ViewportPanel.tsx';
import { describeObject, type FieldSpec, labelOf } from './schema.ts';

const COMPONENT_ICONS: Record<string, string> = {
  MeshRenderer: 'cube',
  Light: 'light',
  Camera: 'camera',
  RigidBody: 'target',
  Collider: 'empty',
  CharacterController: 'move',
  Script: 'script',
  AudioSource: 'audio',
  UIText: 'file',
};

/** Fields that do not apply to the current variant of a component (e.g. radius on a box collider). */
function fieldHidden(c: ComponentData, key: string): boolean {
  if (c.type === 'Collider') {
    const s = String(c.shape ?? 'auto');
    if (key === 'size') return s !== 'box';
    if (key === 'radius') return !['sphere', 'capsule', 'cylinder'].includes(s);
    if (key === 'height') return !['capsule', 'cylinder'].includes(s);
  }
  if (c.type === 'Light') {
    const k = String(c.kind ?? 'directional');
    if (key === 'groundColor') return k !== 'hemisphere';
    if (key === 'range') return k !== 'point' && k !== 'spot';
    if (key === 'angle') return k !== 'spot';
    if (key === 'castShadow') return k === 'ambient' || k === 'hemisphere';
  }
  return false;
}

const BUILTIN_SCRIPTS = [
  'Rotator',
  'Spinner',
  'Bobber',
  'PlayerController',
  'FollowCamera',
  'Collectible',
  'HudText',
  'Goal',
  'Hazard',
  'MovingPlatform',
  'Lifetime',
];

export function InspectorPanel(_props: PanelProps) {
  const entity = useEditor(selectedEntity);
  const hasScene = useEditor((s) => !!activeScene(s));
  if (!hasScene) return <div className="panel-empty">No scene open.</div>;
  return (
    <div className="panel inspector">
      <div className="panel-body inspector-body">
        {entity ? <EntityInspector key={entity.id} entity={entity} /> : <SceneSettingsInspector />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ entity

function EntityInspector({ entity }: { entity: Entity }) {
  const e = entity;
  const upd = (patch: Record<string, unknown>) => void run('entity_update', { entity: e.id, ...patch });
  const present = new Set(e.components.map((c) => c.type));
  const addItems: MenuItem[] = [];
  const byCategory = new Map<string, MenuItem[]>();
  for (const def of listComponentDefs()) {
    const list = byCategory.get(def.category) ?? [];
    list.push({
      label: def.type,
      icon: COMPONENT_ICONS[def.type] ?? 'settings',
      disabled: !def.multiple && present.has(def.type),
      onClick: () => void addComponent(e, def.type),
    });
    byCategory.set(def.category, list);
  }
  for (const [cat, items] of byCategory) addItems.push({ header: labelOf(cat) }, ...items);

  return (
    <div className="inspector-entity" data-testid="inspector">
      <div className="insp-header">
        <input
          type="checkbox"
          className="checkbox"
          checked={e.active}
          title={e.active ? 'Active' : 'Inactive'}
          onChange={(ev) => upd({ active: ev.target.checked })}
        />
        <TextField
          value={e.name}
          onCommit={(name) => name.trim() && upd({ name: name.trim() })}
          className="insp-name"
        />
        <span className="insp-id" title="Entity id">
          {e.id}
        </span>
      </div>
      <div className="insp-row">
        <span className="insp-label">Tags</span>
        <TextField
          value={e.tags.join(', ')}
          placeholder="Player, Coin, ..."
          onCommit={(v) =>
            upd({
              tags: v
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            })
          }
        />
      </div>
      {e.prefab ? (
        <div className="insp-row">
          <span className="insp-label">Prefab</span>
          <span className="muted mono">{e.prefab}</span>
        </div>
      ) : null}

      <Section title="Transform" icon="move">
        <TransformFields entity={e} />
      </Section>

      {e.components.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: components have no ids; their index is their identity
        <ComponentSection key={`${c.type}-${i}`} entity={e} comp={c} index={i} />
      ))}

      <div className="insp-add">
        <button type="button" className="btn" onClick={(ev) => openMenuAt(ev.currentTarget, addItems)}>
          <Icon name="plus" size={14} /> Add Component
        </button>
      </div>
    </div>
  );
}

async function addComponent(e: Entity, type: string): Promise<void> {
  const component: Record<string, unknown> = {
    type,
    ...(type === 'Script' ? { script: 'builtin:Rotator' } : {}),
  };
  if (type === 'MeshRenderer') component.primitive = 'box';
  await run('component_add', { entity: e.id, component });
}

function Section({
  title,
  icon,
  children,
  actions,
  onContext,
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  onContext?: (ev: React.MouseEvent) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="insp-section">
      <div className="insp-section-head" role="toolbar" aria-label={title} onContextMenu={onContext}>
        <button type="button" className="insp-fold" onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
          <Icon name={icon} size={14} className="insp-section-icon" />
          <span>{title}</span>
        </button>
        {actions}
      </div>
      {open ? <div className="insp-section-body">{children}</div> : null}
    </div>
  );
}

function TransformFields({ entity }: { entity: Entity }) {
  const t = entity.transform;
  const field = (key: 'position' | 'rotation' | 'scale', label: string, step: number) => (
    <div className="insp-row">
      <span className="insp-label">{label}</span>
      <Vec3Field
        value={t[key]}
        step={step}
        onChange={(v, final) => {
          if (!final) sceneViewport()?.previewTransform(entity.id, { [key]: v });
          else void run('entity_update', { entity: entity.id, [key]: v });
        }}
      />
    </div>
  );
  return (
    <>
      {field('position', 'Position', 0.05)}
      {field('rotation', 'Rotation', 1)}
      {field('scale', 'Scale', 0.02)}
    </>
  );
}

function ComponentSection({ entity, comp, index }: { entity: Entity; comp: ComponentData; index: number }) {
  const typeIndex = entity.components.slice(0, index).filter((c) => c.type === comp.type).length;
  let fields: FieldSpec[] = [];
  let description = '';
  try {
    const def = getComponentDef(comp.type);
    fields = describeObject(def.schema);
    description = def.description;
  } catch {
    // unknown component type: show raw JSON
  }
  const update = (props: Record<string, unknown>) =>
    void run('component_update', { entity: entity.id, type: comp.type, index: typeIndex, props });
  const remove = () => void run('component_remove', { entity: entity.id, type: comp.type, index: typeIndex });
  /** Optional fields cannot be unset with component_update: replace the component in one transaction. */
  const clearField = async (key: string) => {
    const { type, [key]: _drop, ...rest } = comp;
    await host
      .request({
        type: 'transaction',
        label: `Clear ${comp.type}.${key}`,
        calls: [
          { name: 'component_remove', input: { entity: entity.id, type, index: typeIndex } },
          { name: 'component_add', input: { entity: entity.id, component: { type, ...rest } } },
        ],
        source: 'ui',
      })
      .catch(() => undefined);
  };
  const menu = (ev: React.MouseEvent) => {
    ev.preventDefault();
    openMenu(ev.clientX, ev.clientY, [
      { label: `Remove ${comp.type}`, icon: 'trash', danger: true, onClick: remove },
      {
        label: 'Copy as JSON',
        icon: 'copy',
        onClick: () => void navigator.clipboard?.writeText(JSON.stringify(comp)),
      },
    ]);
  };
  const title =
    comp.type === 'Script'
      ? `Script · ${String(comp.script ?? '')
          .replace(/^scripts\//, '')
          .replace(/^builtin:/, '')}`
      : comp.type;
  return (
    <Section
      title={title}
      icon={COMPONENT_ICONS[comp.type] ?? 'settings'}
      onContext={menu}
      actions={
        <>
          {comp.type === 'Script' ? (
            <Toggle
              checked={comp.enabled !== false}
              title="Enabled"
              onChange={(v) => update({ enabled: v })}
            />
          ) : null}
          <button type="button" className="icon-btn small" title="Component menu" onClick={(ev) => menu(ev)}>
            <Icon name="dots" size={14} />
          </button>
        </>
      }
    >
      {description ? <div className="insp-desc">{description.split('. ')[0]}.</div> : null}
      {fields
        .filter((f) => !(comp.type === 'Script' && f.key === 'enabled') && !fieldHidden(comp, f.key))
        .map((f) => (
          <FieldRow
            key={f.key}
            comp={comp}
            spec={f}
            entity={entity}
            onChange={(v) => update({ [f.key]: v })}
            onClear={() => void clearField(f.key)}
          />
        ))}
    </Section>
  );
}

function FieldRow({
  comp,
  spec,
  entity,
  onChange,
  onClear,
}: {
  comp: ComponentData;
  spec: FieldSpec;
  entity: Entity;
  onChange: (v: unknown) => void;
  onClear: () => void;
}) {
  const value = comp[spec.key];
  // Records get custom editors (recipe params, script props).
  if (spec.kind === 'record') {
    if (comp.type === 'MeshRenderer' && spec.key === 'params') {
      return comp.model ? (
        <ModelParams
          model={comp.model as string}
          value={(value as Record<string, unknown>) ?? {}}
          onChange={onChange}
        />
      ) : null;
    }
    if (comp.type === 'Script' && spec.key === 'props') {
      return (
        <ScriptProps
          script={String(comp.script ?? '')}
          value={(value as Record<string, unknown>) ?? {}}
          onChange={onChange}
        />
      );
    }
  }
  const isSet = value !== undefined;
  return (
    <div className="insp-row" title={spec.description}>
      <span className="insp-label">{labelOf(spec.key)}</span>
      <div className="insp-value">
        <FieldEditor comp={comp} spec={spec} value={value} onChange={onChange} entity={entity} />
        {spec.optional && isSet ? (
          <button type="button" className="icon-btn small" title="Clear" onClick={onClear}>
            <Icon name="x" size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FieldEditor({
  comp,
  spec,
  value,
  onChange,
}: {
  comp: ComponentData;
  spec: FieldSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  entity: Entity;
}) {
  const v = value ?? spec.defaultValue;
  switch (spec.kind) {
    case 'number': {
      const n = typeof v === 'number' ? v : 0;
      if (spec.min !== undefined && spec.max !== undefined && spec.max - spec.min <= 100)
        return (
          <SliderField
            value={n}
            min={spec.min}
            max={spec.max}
            int={!!spec.int}
            onChange={(x, final) => final && onChange(x)}
          />
        );
      return (
        <NumberField
          value={n}
          step={spec.int ? 1 : 0.1}
          int={!!spec.int}
          {...(spec.min !== undefined ? { min: spec.min } : {})}
          {...(spec.max !== undefined ? { max: spec.max } : {})}
          onChange={(x, final) => final && onChange(x)}
        />
      );
    }
    case 'boolean':
      return <Toggle checked={!!v} onChange={onChange} />;
    case 'enum':
      return (
        <SelectField
          value={(v as string) ?? ''}
          options={spec.options ?? []}
          {...(spec.optional ? { placeholder: '(none)' } : {})}
          onChange={(x) => x && onChange(x)}
        />
      );
    case 'color':
      return value === undefined && spec.optional ? (
        <button type="button" className="btn small ghost" onClick={() => onChange('#ffffff')}>
          <Icon name="plus" size={12} /> Set color
        </button>
      ) : (
        <ColorField value={(v as string) ?? '#ffffff'} onChange={onChange} />
      );
    case 'vec3':
      return <Vec3Field value={(v as number[]) ?? [0, 0, 0]} onChange={(x, final) => final && onChange(x)} />;
    case 'vec2':
      return <Vec2Field value={(v as number[]) ?? [0, 0]} onChange={(x, final) => final && onChange(x)} />;
    case 'asset':
      return <AssetPicker comp={comp} field={spec.key} value={(value as string) ?? ''} onChange={onChange} />;
    case 'string':
      if (comp.type === 'Script' && spec.key === 'script')
        return <ScriptPicker value={(v as string) ?? ''} onChange={onChange} />;
      return <TextField value={(v as string) ?? ''} onCommit={onChange} />;
    default:
      return <JsonField value={v} onChange={onChange} />;
  }
}

function AssetPicker({
  comp,
  field,
  value,
  onChange,
}: {
  comp: ComponentData;
  field: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const files = useEditor((s) => s.files);
  const materials = useEditor((s) => s.state?.materials);
  const options = useMemo(() => {
    if (comp.type === 'MeshRenderer' && field === 'model')
      return files
        .filter((f) => /\.model\.ts$|\.glb$/.test(f))
        .map((f) => ({
          value: f,
          label: f.replace(/^models\//, ''),
          group: f.startsWith('models/templates/') ? 'Templates' : 'Models',
        }));
    if (field === 'material')
      return Object.keys(materials ?? {}).map((m) => ({ value: m, label: m.replace(/^materials\//, '') }));
    if (field === 'clip')
      return files.filter((f) => /\.(mp3|ogg|wav)$/i.test(f)).map((f) => ({ value: f, label: f }));
    return files.map((f) => ({ value: f, label: f }));
  }, [comp.type, field, files, materials]);
  const withCurrent =
    value && !options.some((o) => o.value === value)
      ? [{ value, label: `${value} (missing)` }, ...options]
      : options;
  return (
    <div className="asset-picker">
      <SelectField
        value={value}
        options={withCurrent}
        placeholder="(none)"
        onChange={(v) => v && onChange(v)}
      />
      {comp.type === 'MeshRenderer' && field === 'model' && value?.endsWith('.model.ts') ? (
        <button
          type="button"
          className="icon-btn small"
          title="Open in the Modeling workspace"
          onClick={() => openModel(value)}
        >
          <Icon name="model" size={13} />
        </button>
      ) : null}
    </div>
  );
}

function ScriptPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const files = useEditor((s) => s.files);
  const options = [
    ...files
      .filter((f) => f.startsWith('scripts/') && f.endsWith('.ts') && !f.endsWith('.d.ts'))
      .map((f) => ({ value: f, label: f.replace(/^scripts\//, ''), group: 'Project scripts' })),
    ...BUILTIN_SCRIPTS.map((b) => ({ value: `builtin:${b}`, label: b, group: 'Built-in' })),
  ];
  const withCurrent =
    value && !options.some((o) => o.value === value)
      ? [{ value, label: `${value} (missing)`, group: 'Project scripts' }, ...options]
      : options;
  return (
    <div className="asset-picker">
      <SelectField value={value} options={withCurrent} onChange={(v) => v && onChange(v)} />
      {value.startsWith('scripts/') ? (
        <button
          type="button"
          className="icon-btn small"
          title="Edit script"
          onClick={() => openScript(value)}
        >
          <Icon name="code" size={13} />
        </button>
      ) : null}
    </div>
  );
}

function JsonField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const shown = text ?? JSON.stringify(value ?? null);
  return (
    <input
      className={`input mono${error ? ' invalid' : ''}`}
      value={shown}
      onFocus={() => setText(JSON.stringify(value ?? null))}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text === null) return;
        try {
          const parsed = JSON.parse(text);
          setError(false);
          setText(null);
          if (JSON.stringify(parsed) !== JSON.stringify(value)) onChange(parsed);
        } catch {
          setError(true);
        }
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** Editor for a single dynamic value (script props, recipe params) by the type of its default. */
function DynamicValue({
  value,
  def,
  onChange,
}: {
  value: unknown;
  def: unknown;
  onChange: (v: unknown) => void;
}) {
  const sample = value ?? def;
  if (typeof sample === 'number')
    return (
      <NumberField
        value={(value as number) ?? (def as number)}
        onChange={(x, final) => final && onChange(x)}
      />
    );
  if (typeof sample === 'boolean') return <Toggle checked={!!(value ?? def)} onChange={onChange} />;
  if (typeof sample === 'string' && /^#[0-9a-f]{6}$/i.test(sample))
    return <ColorField value={(value ?? def) as string} onChange={onChange} />;
  if (typeof sample === 'string') return <TextField value={(value ?? def) as string} onCommit={onChange} />;
  if (Array.isArray(sample) && sample.length === 3 && sample.every((n) => typeof n === 'number'))
    return <Vec3Field value={(value ?? def) as number[]} onChange={(x, final) => final && onChange(x)} />;
  return <JsonField value={value ?? def} onChange={onChange} />;
}

function ScriptProps({
  script,
  value,
  onChange,
}: {
  script: string;
  value: Record<string, unknown>;
  onChange: (v: unknown) => void;
}) {
  const versions = useEditor((s) => s.fileVersions);
  const files = useEditor((s) => s.files);
  const versionKey = useMemo(
    () =>
      JSON.stringify([
        files.filter((f) => f.startsWith('scripts/')),
        Object.entries(versions).filter(([k]) => k.startsWith('scripts/')),
      ]),
    [files, versions],
  );
  const [defaults, setDefaults] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let alive = true;
    void scriptProps(versionKey).then((all) => alive && setDefaults(all[script] ?? {}));
    return () => {
      alive = false;
    };
  }, [script, versionKey]);
  const keys = [...new Set([...Object.keys(defaults ?? {}), ...Object.keys(value)])];
  if (!defaults && !keys.length) return <div className="insp-desc">Loading script properties...</div>;
  if (!keys.length) return <div className="insp-desc">This script has no properties.</div>;
  return (
    <div className="insp-props">
      <div className="insp-subhead">Properties</div>
      {keys.map((k) => (
        <div key={k} className={`insp-row${k in value ? ' overridden' : ''}`}>
          <span className="insp-label" title={k in value ? 'Overridden' : 'Default'}>
            {labelOf(k)}
          </span>
          <div className="insp-value">
            <DynamicValue
              value={value[k]}
              def={defaults?.[k]}
              onChange={(v) => onChange({ ...value, [k]: v })}
            />
            {k in value ? (
              <button
                type="button"
                className="icon-btn small"
                title="Reset to default"
                onClick={() => {
                  const { [k]: _drop, ...rest } = value;
                  onChange(rest);
                }}
              >
                <Icon name="refresh" size={12} />
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function ModelParams({
  model,
  value,
  onChange,
}: {
  model: string;
  value: Record<string, unknown>;
  onChange: (v: unknown) => void;
}) {
  const [defs, setDefs] = useState<Record<string, ParamDefLite> | null>(null);
  const version = useEditor((s) => s.fileVersions[model] ?? 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the recipe file changes
  useEffect(() => {
    let alive = true;
    void resolveModel(model, {}).then((r) => alive && setDefs(r?.info.paramDefs ?? {}));
    return () => {
      alive = false;
    };
  }, [model, version]);
  if (!defs) return null;
  const keys = Object.keys(defs);
  if (!keys.length) return null;
  return (
    <div className="insp-props">
      <div className="insp-subhead">Model parameters</div>
      {keys.map((k) => {
        const d = defs[k]!;
        const cur = value[k] ?? d.default;
        const set = (v: unknown) => onChange({ ...value, [k]: v });
        return (
          <div key={k} className={`insp-row${k in value ? ' overridden' : ''}`} title={d.description}>
            <span className="insp-label">{labelOf(k)}</span>
            <div className="insp-value">
              <ParamEditor def={d} value={cur} onChange={set} />
              {k in value ? (
                <button
                  type="button"
                  className="icon-btn small"
                  title="Reset to default"
                  onClick={() => {
                    const { [k]: _drop, ...rest } = value;
                    onChange(rest);
                  }}
                >
                  <Icon name="refresh" size={12} />
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ParamEditor({
  def,
  value,
  onChange,
  live,
}: {
  def: ParamDefLite;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Called while dragging sliders (modeling preview). */
  live?: (v: unknown) => void;
}) {
  switch (def.type) {
    case 'number':
    case 'int': {
      const n = typeof value === 'number' ? value : def.default;
      const int = def.type === 'int';
      if (def.min !== undefined && def.max !== undefined)
        return (
          <SliderField
            value={n}
            min={def.min}
            max={def.max}
            int={int}
            {...(def.type === 'number' && def.step !== undefined ? { step: def.step } : {})}
            onChange={(x, final) => (final ? onChange(x) : live?.(x))}
          />
        );
      return (
        <NumberField
          value={n}
          int={int}
          step={int ? 1 : 0.05}
          onChange={(x, final) => (final ? onChange(x) : live?.(x))}
        />
      );
    }
    case 'color':
      return <ColorField value={typeof value === 'string' ? value : def.default} onChange={onChange} />;
    case 'boolean':
      return <Toggle checked={typeof value === 'boolean' ? value : def.default} onChange={onChange} />;
    case 'choice':
      return (
        <SelectField value={(value as string) ?? def.default} options={def.options} onChange={onChange} />
      );
  }
}

// ------------------------------------------------------------------ scene settings (nothing selected)

function SceneSettingsInspector() {
  const scene = useEditor(activeScene);
  const scenePath = useEditor((s) => s.state?.activeScene ?? '');
  if (!scene) return null;
  const s = scene.settings;
  const set = (patch: Record<string, unknown>) => void run('scene_settings', patch);
  const fields = describeObject(SceneSettings).filter((f) => f.key !== 'fog');
  return (
    <div className="inspector-entity">
      <div className="insp-header scene">
        <Icon name="scene" size={16} />
        <span className="insp-scene-name">{scene.name}</span>
        <span className="insp-id">{scenePath}</span>
      </div>
      <div className="insp-hint">Select an entity in the Hierarchy or the Scene view to edit it.</div>
      <Section title="Environment" icon="sun">
        {fields.map((f) => (
          <div key={f.key} className="insp-row" title={f.description}>
            <span className="insp-label">{labelOf(f.key)}</span>
            <div className="insp-value">
              <FieldEditor
                comp={{ type: 'SceneSettings', ...(s as unknown as Record<string, unknown>) }}
                spec={f}
                value={(s as unknown as Record<string, unknown>)[f.key]}
                onChange={(v) => set({ [f.key]: v })}
                entity={{} as Entity}
              />
            </div>
          </div>
        ))}
        <div className="insp-row">
          <span className="insp-label">Fog</span>
          <div className="insp-value">
            <Toggle
              checked={!!s.fog}
              onChange={(on) => set({ fog: on ? { color: s.background, near: 30, far: 120 } : null })}
            />
          </div>
        </div>
        {s.fog ? (
          <>
            <div className="insp-row">
              <span className="insp-label">Fog Color</span>
              <ColorField value={s.fog.color} onChange={(c) => set({ fog: { ...s.fog!, color: c } })} />
            </div>
            <div className="insp-row">
              <span className="insp-label">Fog Near / Far</span>
              <Vec2Field
                value={[s.fog.near, s.fog.far]}
                onChange={(v, final) => final && set({ fog: { ...s.fog!, near: v[0], far: v[1] } })}
              />
            </div>
          </>
        ) : null}
      </Section>
      <ProjectSummary />
    </div>
  );
}

function ProjectSummary() {
  const st = useEditor((s) => s.state);
  if (!st) return null;
  const scenes = Object.keys(st.scenes);
  return (
    <Section title="Project" icon="folder">
      <div className="insp-row">
        <span className="insp-label">Name</span>
        <span>{st.project.name}</span>
      </div>
      <div className="insp-row">
        <span className="insp-label">Scene</span>
        <SelectField
          value={st.activeScene}
          options={scenes.map((p) => ({ value: p, label: st.scenes[p]!.name }))}
          onChange={(p) => void run('scene_open', { scene: p })}
        />
      </div>
      <div className="insp-row">
        <span className="insp-label">Gravity</span>
        <Vec3Field
          value={st.project.physics.gravity}
          onChange={(v, final) => final && void run('project_settings', { gravity: v })}
        />
      </div>
      <div className="insp-row">
        <span className="insp-label">Shadows</span>
        <Toggle
          checked={st.project.render.shadows}
          onChange={(v) => void run('project_settings', { render: { shadows: v } })}
        />
      </div>
      <div className="insp-row">
        <span className="insp-label">Tone Mapping</span>
        <SelectField
          value={st.project.render.toneMapping}
          options={['none', 'aces', 'agx', 'neutral'] as const}
          onChange={(v) => void run('project_settings', { render: { toneMapping: v } })}
        />
      </div>
      <div className="insp-row">
        <span className="insp-label">Exposure</span>
        <NumberField
          value={st.project.render.exposure}
          step={0.05}
          min={0.05}
          onChange={(v, final) => final && void run('project_settings', { render: { exposure: v } })}
        />
      </div>
    </Section>
  );
}
